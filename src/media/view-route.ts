import { loadConfig } from "../config";
import { GramScopeError } from "../errors/taxonomy";
import { withTelegram, type TelegramLike } from "../telegram/client";
import { resolveMediaAsset, type MediaAsset } from "../telegram/media";
import { materializeMediaView, type GeneratedMediaView } from "./materializer";
import { safeMediaFilename } from "./names";
import { contentDispositionAttachment } from "./original-route";
import type { MediaRepresentationPlan } from "./representation";
import { verifyMediaCapability, type VerifiedMediaCapability } from "./token";

export type ViewRouteDependencies = {
  verifyToken(token: string): Promise<VerifiedMediaCapability>;
  withClient<T>(run: (client: TelegramLike) => Promise<T>): Promise<T>;
  resolveAsset(
    client: TelegramLike,
    input: { sourceId: string; messageId: number },
  ): Promise<MediaAsset>;
  materialize(
    client: TelegramLike,
    asset: MediaAsset,
    plan: Exclude<MediaRepresentationPlan, { kind: "original" }>,
  ): Promise<GeneratedMediaView>;
  ownerId: string;
};

function productionViewDependencies(): ViewRouteDependencies {
  const config = loadConfig();
  return {
    verifyToken: (token) => verifyMediaCapability(token, new Date(), config.mediaTokenSecret),
    withClient: withTelegram,
    resolveAsset: resolveMediaAsset,
    materialize: materializeMediaView,
    ownerId: config.ownerUserId,
  };
}

function completeViewDependencies(
  value: Partial<ViewRouteDependencies>,
): value is ViewRouteDependencies {
  return typeof value.verifyToken === "function" &&
    typeof value.withClient === "function" &&
    typeof value.resolveAsset === "function" &&
    typeof value.materialize === "function" &&
    typeof value.ownerId === "string";
}

function sanitizedViewError(error: unknown): Response {
  if (error instanceof GramScopeError) {
    if (error.code === "AUTH_REQUIRED" || error.code === "OWNER_FORBIDDEN") {
      return new Response("Unauthorized", { status: 401 });
    }
    if (["MEDIA_NOT_FOUND", "NO_MEDIA"].includes(error.code)) {
      return new Response("Not Found", { status: 404 });
    }
    if (["INLINE_LIMIT_EXCEEDED", "UNSUPPORTED_MEDIA"].includes(error.code)) {
      return new Response("Unprocessable Media", { status: 422 });
    }
    if (error.code === "PROCESSING_TIMEOUT") {
      return new Response("Media processing timed out", { status: 504 });
    }
  }
  return new Response("Media view failed", { status: 502 });
}

export async function handleViewRequest(
  request: Request,
  token: string,
  overrides: Partial<ViewRouteDependencies> = {},
): Promise<Response> {
  void request;
  const deps: ViewRouteDependencies = completeViewDependencies(overrides)
    ? overrides
    : { ...productionViewDependencies(), ...overrides };
  try {
    const claims = await deps.verifyToken(token);
    if (claims.v !== 2 || claims.ownerId !== deps.ownerId) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (claims.representation.kind === "original") return new Response("Unauthorized", { status: 401 });
    const representation = claims.representation;
    return await deps.withClient(async (client) => {
      const media = await deps.resolveAsset(client, {
        sourceId: claims.sourceId,
        messageId: claims.messageId,
      });
      const generated = await deps.materialize(client, media, representation);
      const filename = safeMediaFilename({
        kind: generated.mimeType === "image/jpeg" ? "photo" : media.descriptor.type,
        messageId: media.messageId,
        mimeType: generated.mimeType,
      });
      return new Response(new Uint8Array(generated.data), {
        status: 200,
        headers: {
          "content-type": generated.mimeType,
          "content-length": String(generated.data.length),
          "content-disposition": contentDispositionAttachment(filename),
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
        },
      });
    });
  } catch (error) {
    return sanitizedViewError(error);
  }
}
