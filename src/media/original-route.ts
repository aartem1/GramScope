import {
  isRemoteDispatchEnabled,
  loadConfig,
  loadWorkerClientConfig,
  type WorkerClientConfig,
} from "../config";
import { withTelegram, type TelegramLike } from "../telegram/client";
import {
  iterAssetBytes,
  resolveMediaAsset,
  type MediaAsset,
} from "../telegram/media";
import { originalRouteErrorResponse } from "./http-errors";
import { safeMediaFilename } from "./names";
import {
  parseSingleRange,
  RangeNotSatisfiableError,
  type ByteRange,
} from "./range";
import {
  verifyMediaCapability,
  type VerifiedMediaCapability,
} from "./token";
import { fetchMediaFromWorker } from "./worker-proxy";
import type { MediaRepresentationWire } from "./wire";

export type OriginalRouteDependencies = {
  verifyToken(token: string): Promise<VerifiedMediaCapability>;
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
  workerConfig?: WorkerClientConfig;
  fetchFromWorker?(
    body: {
      sourceId: string;
      messageId: number;
      representation: MediaRepresentationWire;
      range?: { start: number; end: number };
    },
    signal?: AbortSignal,
  ): Promise<Response>;
};

function productionOriginalRouteDependencies(): OriginalRouteDependencies {
  const config = loadConfig();
  const deps: OriginalRouteDependencies = {
    verifyToken: (token) =>
      verifyMediaCapability(token, new Date(), config.mediaTokenSecret),
    withClient: withTelegram,
    resolveAsset: resolveMediaAsset,
    iterBytes: iterAssetBytes,
    ownerId: config.ownerUserId,
  };
  if (isRemoteDispatchEnabled() && config.worker) {
    deps.workerConfig = loadWorkerClientConfig();
    deps.fetchFromWorker = (body, signal) =>
      fetchMediaFromWorker({
        config: deps.workerConfig!,
        body,
        signal,
      });
  }
  return deps;
}

function completeDependencies(
  value: Partial<OriginalRouteDependencies>,
): value is OriginalRouteDependencies {
  const hasLocal =
    typeof value.withClient === "function" &&
    typeof value.resolveAsset === "function" &&
    typeof value.iterBytes === "function";
  const hasRemote = typeof value.fetchFromWorker === "function";
  return typeof value.verifyToken === "function" &&
    typeof value.ownerId === "string" &&
    (hasLocal || hasRemote);
}

export function contentDispositionAttachment(filename: string): string {
  const clean = filename.replace(/[\r\n"]/g, "_");
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_") || "download.bin";
  const encoded = encodeURIComponent(clean)
    .replace(/['()*]/g, (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function originalByteSize(claims: VerifiedMediaCapability): number | undefined {
  if (claims.v === 2 && claims.representation.kind === "original") {
    return claims.representation.byteSize;
  }
  return undefined;
}

function wireRepresentation(
  claims: VerifiedMediaCapability,
): MediaRepresentationWire {
  if (claims.v === 2) {
    const { representation } = claims;
    if (representation.kind === "original") {
      return { kind: "original" };
    }
    return representation;
  }
  return { kind: "original" };
}

function mimeKind(mimeType: string | null): string {
  if (!mimeType) return "download";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("image/")) return "photo";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType === "application/pdf") return "document";
  return "download";
}

function proxyResponseHeaders(
  upstream: Response,
  claims: VerifiedMediaCapability,
): Headers {
  const contentType = upstream.headers.get("content-type");
  const filename = safeMediaFilename({
    kind: mimeKind(contentType),
    messageId: claims.messageId,
    mimeType: contentType ?? undefined,
  });
  const headers = new Headers({
    "content-type": contentType ?? "application/octet-stream",
    "content-disposition": contentDispositionAttachment(filename),
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
  const length = upstream.headers.get("content-length");
  if (length) headers.set("content-length", length);
  const contentRange = upstream.headers.get("content-range");
  if (contentRange) headers.set("content-range", contentRange);
  if (upstream.status === 200 || upstream.status === 206) {
    headers.set("accept-ranges", "bytes");
  }
  return headers;
}

async function handleOriginalProxy(
  request: Request,
  claims: VerifiedMediaCapability,
  deps: OriginalRouteDependencies,
): Promise<Response> {
  const byteSize = originalByteSize(claims);
  let parsedRange: ByteRange | undefined;
  try {
    const rangeHeader = request.headers.get("range");
    if (rangeHeader !== null) {
      if (byteSize === undefined) {
        return new Response("Media size unavailable", { status: 422 });
      }
      parsedRange = parseSingleRange(rangeHeader, byteSize);
    }
  } catch (error) {
    if (error instanceof RangeNotSatisfiableError) {
      return new Response("Range Not Satisfiable", {
        status: 416,
        headers: { "content-range": `bytes */${error.size}` },
      });
    }
    throw error;
  }

  const upstream = await deps.fetchFromWorker!(
    {
      sourceId: claims.sourceId,
      messageId: claims.messageId,
      representation: wireRepresentation(claims),
      ...(parsedRange
        ? { range: { start: parsedRange.start, end: parsedRange.end } }
        : {}),
    },
    request.signal,
  );

  if (upstream.status !== 200 && upstream.status !== 206) {
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: upstream.headers,
    });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: proxyResponseHeaders(upstream, claims),
  });
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
    if (
      claims.ownerId !== deps.ownerId ||
      (claims.v === 2 && claims.representation.kind !== "original")
    ) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (deps.fetchFromWorker) {
      return handleOriginalProxy(request, claims, deps);
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
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    if (error instanceof RangeNotSatisfiableError) {
      return new Response("Range Not Satisfiable", {
        status: 416,
        headers: { "content-range": `bytes */${error.size}` },
      });
    }
    return originalRouteErrorResponse(error);
  }
}
