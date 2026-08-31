import { loadConfig } from "../config";
import { GramScopeError } from "../errors/taxonomy";
import { withTelegram, type TelegramLike } from "../telegram/client";
import {
  iterAssetBytes,
  resolveMediaAsset,
  type MediaAsset,
} from "../telegram/media";
import { safeMediaFilename } from "./names";
import {
  parseSingleRange,
  RangeNotSatisfiableError,
} from "./range";
import {
  verifyMediaToken,
  type MediaTokenClaims,
} from "./token";

export type OriginalRouteDependencies = {
  verifyToken(token: string): Promise<MediaTokenClaims>;
  withClient<T>(run: (client: TelegramLike) => Promise<T>): Promise<T>;
  resolveAsset(
    client: TelegramLike,
    input: { sourceId: string; messageId: number },
  ): Promise<MediaAsset>;
  iterBytes(
    client: TelegramLike,
    asset: MediaAsset,
    options: { offset?: number; limit?: number; signal?: AbortSignal },
  ): AsyncIterable<Buffer>;
  ownerId: string;
};

function productionOriginalRouteDependencies(): OriginalRouteDependencies {
  const config = loadConfig();
  return {
    verifyToken: (token) =>
      verifyMediaToken(token, new Date(), config.mediaTokenSecret),
    withClient: withTelegram,
    resolveAsset: resolveMediaAsset,
    iterBytes: iterAssetBytes,
    ownerId: config.ownerUserId,
  };
}

function completeDependencies(
  value: Partial<OriginalRouteDependencies>,
): value is OriginalRouteDependencies {
  return typeof value.verifyToken === "function" &&
    typeof value.withClient === "function" &&
    typeof value.resolveAsset === "function" &&
    typeof value.iterBytes === "function" &&
    typeof value.ownerId === "string";
}

export function contentDispositionAttachment(filename: string): string {
  const clean = filename.replace(/[\r\n"]/g, "_");
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_") || "download.bin";
  const encoded = encodeURIComponent(clean)
    .replace(/['()*]/g, (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export async function handleOriginalRequest(
  request: Request,
  token: string,
  overrides: Partial<OriginalRouteDependencies> = {},
): Promise<Response> {
  // Full dependency injection keeps unit tests isolated from process secrets.
  // Any production or partial invocation still loads and validates all config.
  const deps: OriginalRouteDependencies = completeDependencies(overrides)
    ? overrides
    : { ...productionOriginalRouteDependencies(), ...overrides };

  try {
    const claims = await deps.verifyToken(token);
    if (claims.ownerId !== deps.ownerId) {
      return new Response("Unauthorized", { status: 401 });
    }

    return await deps.withClient(async (client) => {
      const asset = await deps.resolveAsset(client, {
        sourceId: claims.sourceId,
        messageId: claims.messageId,
      });
      const size = asset.descriptor.size;
      if (size === undefined) {
        return new Response("Media size unavailable", { status: 422 });
      }
      const range = parseSingleRange(request.headers.get("range"), size);
      const abort = new AbortController();
      const iterator = deps.iterBytes(client, asset, {
        ...(range ? { offset: range.start, limit: range.length } : {}),
        signal: abort.signal,
      })[Symbol.asyncIterator]();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const next = await iterator.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
        async cancel() {
          abort.abort();
          await iterator.return?.();
        },
      });
      const filename = safeMediaFilename({
        supplied: asset.descriptor.file_name,
        kind: asset.descriptor.type,
        messageId: asset.messageId,
        mimeType: asset.descriptor.mime_type,
      });
      const length = range?.length ?? size;
      const headers = new Headers({
        "content-type": asset.descriptor.mime_type ?? "application/octet-stream",
        "content-length": String(length),
        "content-disposition": contentDispositionAttachment(filename),
        "accept-ranges": "bytes",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      });
      if (range) {
        headers.set(
          "content-range",
          `bytes ${range.start}-${range.end}/${size}`,
        );
      }
      return new Response(body, {
        status: range ? 206 : 200,
        headers,
      });
    });
  } catch (error) {
    if (error instanceof RangeNotSatisfiableError) {
      return new Response("Range Not Satisfiable", {
        status: 416,
        headers: { "content-range": `bytes */${error.size}` },
      });
    }
    if (error instanceof GramScopeError && error.code === "AUTH_REQUIRED") {
      return new Response("Unauthorized", { status: 401 });
    }
    if (
      error instanceof GramScopeError &&
      ["MEDIA_NOT_FOUND", "NO_MEDIA"].includes(error.code)
    ) {
      return new Response("Not Found", { status: 404 });
    }
    return new Response("Media download failed", { status: 502 });
  }
}
