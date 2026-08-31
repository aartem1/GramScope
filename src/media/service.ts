import type {
  GetMediaInput,
  GetMediaResult,
  MediaResultCode,
} from "../schemas/media";
import { INLINE_MEDIA_MAX_BYTES } from "../schemas/media";
import { GramScopeError } from "../errors/taxonomy";
import { loadConfig } from "../config";
import { normalizeImage } from "./image";
import { safeMediaFilename } from "./names";
import { issueMediaToken } from "./token";
import { withTelegram, type TelegramLike } from "../telegram/client";
import {
  readAssetBytes,
  readAssetThumbnail,
  resolveMediaAsset,
  type MediaAsset,
} from "../telegram/media";

export type { MediaAsset } from "../telegram/media";

export type MediaArtifact = {
  type: "image" | "audio";
  data: Buffer;
  mimeType: string;
};

export type MediaOutcome = {
  result: GetMediaResult;
  artifact?: MediaArtifact;
  link?: { uri: string; name: string; mimeType?: string; size?: number };
};

export type MediaDependencies = {
  withClient<T>(run: (client: TelegramLike) => Promise<T>): Promise<T>;
  resolveAsset(client: TelegramLike, input: { sourceId: string; messageId: number }): Promise<MediaAsset>;
  readBytes(client: TelegramLike, asset: MediaAsset, limit: number, signal?: AbortSignal): Promise<Buffer>;
  readThumbnail?: (
    client: TelegramLike,
    asset: MediaAsset,
    limit: number,
    signal?: AbortSignal,
  ) => Promise<MediaArtifact | undefined>;
  normalizeImage?: (source: Buffer, options?: {
    preserveTransparency?: boolean;
    sourceMimeType?: string;
  }) => Promise<{
    data: Buffer; mimeType: "image/jpeg" | "image/png" | "image/webp"; width: number; height: number;
  }>;
  attachOriginalLink?: (asset: MediaAsset, outcome: MediaOutcome) => Promise<MediaOutcome>;
  downloadToFile?: (
    client: TelegramLike,
    asset: MediaAsset,
    options: { path: string; maxBytes: number; deadlineMs: number; signal?: AbortSignal },
  ) => Promise<number>;
  probeDuration?: (inputPath: string, deadline: AbortSignal) => Promise<number>;
  contactSheet?: (inputPath: string, request: {
    timestampsSeconds: number[];
    maxBytes: number;
    maxLongEdge: number;
    deadline: AbortSignal;
  }) => Promise<{
    data: Buffer;
    mimeType: "image/jpeg";
    width: number;
    height: number;
    frameCount: number;
    timestampsSeconds: number[];
  }>;
};

const productionMediaDependencies: MediaDependencies = {
  withClient: withTelegram,
  resolveAsset: resolveMediaAsset,
  readBytes: readAssetBytes,
  readThumbnail: readAssetThumbnail,
  normalizeImage,
  attachOriginalLink,
};

export async function attachOriginalLink(
  asset: MediaAsset,
  outcome: MediaOutcome,
): Promise<MediaOutcome> {
  const config = loadConfig();
  const issued = await issueMediaToken({
    v: 1,
    purpose: "telegram-original",
    sourceId: asset.sourceId,
    messageId: asset.messageId,
    ownerId: config.ownerUserId,
  }, new Date(), config.mediaTokenSecret);
  const uri = `${new URL(config.mcpResourceUrl).origin}/api/media/${encodeURIComponent(issued.token)}`;
  const name = safeMediaFilename({
    supplied: asset.descriptor.file_name,
    kind: asset.descriptor.type,
    messageId: asset.messageId,
    mimeType: asset.descriptor.mime_type,
  });
  return {
    ...outcome,
    result: {
      ...outcome.result,
      download: {
        url: uri,
        expires_at: issued.expiresAt.toISOString(),
      },
    },
    link: {
      uri,
      name,
      mimeType: asset.descriptor.mime_type,
      size: asset.descriptor.size,
    },
  };
}

function readyOutcome(asset: MediaAsset, artifact: MediaArtifact): MediaOutcome {
  const fileName = safeMediaFilename({
    supplied: asset.descriptor.file_name,
    kind: asset.descriptor.type,
    messageId: asset.messageId,
    mimeType: artifact.mimeType,
  });
  return {
    result: {
      status: "ready",
      source_id: asset.sourceId,
      message_id: asset.messageId,
      media: asset.descriptor,
      representation: {
        kind: artifact.type,
        mime_type: artifact.mimeType,
        ...(fileName ? { file_name: fileName } : {}),
        byte_size: artifact.data.length,
      },
    },
    artifact,
  };
}

function fallbackOutcome(
  asset: MediaAsset,
  code: MediaResultCode,
  retryable: boolean,
): MediaOutcome {
  return {
    result: {
      status: "fallback",
      source_id: asset.sourceId,
      message_id: asset.messageId,
      media: asset.descriptor,
      representation: { kind: "metadata" },
      code,
      retryable,
      message: "The media is available, but no bounded direct representation was produced.",
    },
  };
}

export async function getMedia(
  input: GetMediaInput,
  overrides: Partial<MediaDependencies> = {},
): Promise<MediaOutcome> {
  const deps = { ...productionMediaDependencies, ...overrides };
  return deps.withClient(async (client) => {
    const asset = await deps.resolveAsset(client, {
      sourceId: input.source_id,
      messageId: input.message_id,
    });
    return represent(client, asset, input, deps);
  });
}

async function represent(
  client: TelegramLike,
  asset: MediaAsset,
  input: GetMediaInput,
  deps: MediaDependencies,
): Promise<MediaOutcome> {
  const mode = input.timestamps_seconds?.length ? "frames" : input.mode;
  if (mode === "original") {
    if (!isDirectImage(asset) && !isDirectAudio(asset)) {
      return withOriginalLink(asset, errorOutcome(asset, "UNSUPPORTED_MEDIA", false), deps);
    }
    if (asset.descriptor.size === undefined || asset.descriptor.size > INLINE_MEDIA_MAX_BYTES) {
      return withOriginalLink(asset, fallbackOutcome(asset, "INLINE_LIMIT_EXCEEDED", false), deps);
    }
    return withOriginalLink(asset, await directOriginal(client, asset, deps), deps);
  }
  if (mode === "preview") {
    return isDirectImage(asset)
      ? directImage(client, asset, deps)
      : thumbnailFallback(client, asset, deps);
  }
  if (mode === "frames") {
    if (!["video", "gif", "video_note"].includes(asset.descriptor.type)) {
      return errorOutcome(asset, "UNSUPPORTED_MEDIA", false);
    }
    return thumbnailFallback(client, asset, deps);
  }

  switch (asset.descriptor.type) {
    case "photo":
      return directImage(client, asset, deps);
    case "voice":
    case "audio":
      return directAudioOrFallback(client, asset, deps);
    case "video":
    case "gif":
    case "video_note":
      return thumbnailFallback(client, asset, deps);
    case "sticker":
    case "document":
      return asset.descriptor.mime_type?.startsWith("image/")
        ? directImage(client, asset, deps)
        : thumbnailFallback(client, asset, deps);
    default:
      return errorOutcome(asset, "UNSUPPORTED_MEDIA", false);
  }
}

function isDirectImage(asset: MediaAsset): boolean {
  return asset.descriptor.type === "photo" ||
    (["sticker", "document"].includes(asset.descriptor.type) &&
      asset.descriptor.mime_type?.startsWith("image/") === true);
}

function isDirectAudio(asset: MediaAsset): boolean {
  return ["voice", "audio"].includes(asset.descriptor.type);
}

async function directOriginal(
  client: TelegramLike,
  asset: MediaAsset,
  deps: MediaDependencies,
): Promise<MediaOutcome> {
  if (isDirectImage(asset)) return directImage(client, asset, deps, false);
  try {
    const data = await deps.readBytes(client, asset, INLINE_MEDIA_MAX_BYTES);
    return readyOutcome(asset, {
      type: "audio",
      data,
      mimeType: asset.descriptor.mime_type ?? "audio/ogg",
    });
  } catch (error) {
    if (!(error instanceof GramScopeError) || error.code !== "INLINE_LIMIT_EXCEEDED") throw error;
    return fallbackOutcome(asset, "INLINE_LIMIT_EXCEEDED", false);
  }
}

async function directAudioOrFallback(
  client: TelegramLike,
  asset: MediaAsset,
  deps: MediaDependencies,
): Promise<MediaOutcome> {
  if ((asset.descriptor.size ?? INLINE_MEDIA_MAX_BYTES + 1) > INLINE_MEDIA_MAX_BYTES) {
    return withOriginalLink(asset, fallbackOutcome(asset, "INLINE_LIMIT_EXCEEDED", false), deps);
  }
  const direct = await directOriginal(client, asset, deps);
  return withOriginalLink(asset, direct, deps);
}

async function directImage(
  client: TelegramLike,
  asset: MediaAsset,
  deps: MediaDependencies,
  attachLinkOnFallback = true,
): Promise<MediaOutcome> {
  try {
    return await directImageOnce(client, asset, deps);
  } catch (error) {
    if (!(error instanceof GramScopeError) || error.code !== "INLINE_LIMIT_EXCEEDED") throw error;
    const fallback = fallbackOutcome(asset, "INLINE_LIMIT_EXCEEDED", false);
    return attachLinkOnFallback ? withOriginalLink(asset, fallback, deps) : fallback;
  }
}

async function directImageOnce(
  client: TelegramLike,
  asset: MediaAsset,
  deps: MediaDependencies,
): Promise<MediaOutcome> {
  const thumbnail = await deps.readThumbnail?.(client, asset, INLINE_MEDIA_MAX_BYTES);
  if (!thumbnail && (asset.descriptor.size ?? INLINE_MEDIA_MAX_BYTES + 1) > INLINE_MEDIA_MAX_BYTES) {
    throw new GramScopeError(
      "INLINE_LIMIT_EXCEEDED",
      "Image source exceeds the inline media limit and has no bounded thumbnail",
    );
  }
  const source = thumbnail?.data ?? await deps.readBytes(client, asset, INLINE_MEDIA_MAX_BYTES);
  const processed = await normalizeImageArtifact(
    asset,
    source,
    thumbnail?.mimeType ?? asset.descriptor.mime_type,
    deps,
  );
  const outcome = readyOutcome(asset, {
    type: "image",
    data: processed.data,
    mimeType: processed.mimeType,
  });
  outcome.result.representation = {
    ...outcome.result.representation!,
    width: processed.width,
    height: processed.height,
  };
  return outcome;
}

async function thumbnailFallback(
  client: TelegramLike,
  asset: MediaAsset,
  deps: MediaDependencies,
): Promise<MediaOutcome> {
  try {
    const thumbnail = await deps.readThumbnail?.(client, asset, INLINE_MEDIA_MAX_BYTES);
    const base = fallbackOutcome(asset, "UNSUPPORTED_MEDIA", false);
    if (thumbnail) {
      const processed = await normalizeImageArtifact(asset, thumbnail.data, thumbnail.mimeType, deps);
      base.artifact = { type: "image", data: processed.data, mimeType: processed.mimeType };
      base.result.representation = {
        kind: "image",
        mime_type: processed.mimeType,
        byte_size: processed.data.length,
        width: processed.width,
        height: processed.height,
      };
    }
    return withOriginalLink(asset, base, deps);
  } catch (error) {
    if (!(error instanceof GramScopeError) || error.code !== "INLINE_LIMIT_EXCEEDED") throw error;
    return withOriginalLink(asset, fallbackOutcome(asset, "INLINE_LIMIT_EXCEEDED", false), deps);
  }
}

async function normalizeImageArtifact(
  asset: MediaAsset,
  source: Buffer,
  sourceMimeType: string | undefined,
  deps: MediaDependencies,
): Promise<{ data: Buffer; mimeType: "image/jpeg" | "image/png" | "image/webp"; width: number; height: number }> {
  return deps.normalizeImage
    ? deps.normalizeImage(source, {
      preserveTransparency: asset.descriptor.mime_type === "image/png" ||
        asset.descriptor.mime_type === "image/webp",
      sourceMimeType,
    })
    : {
      data: source,
      mimeType: (sourceMimeType ?? asset.descriptor.mime_type ?? "image/jpeg") as "image/jpeg",
      width: asset.descriptor.width ?? 1,
      height: asset.descriptor.height ?? 1,
    };
}

async function withOriginalLink(
  asset: MediaAsset,
  outcome: MediaOutcome,
  deps: MediaDependencies,
): Promise<MediaOutcome> {
  return deps.attachOriginalLink ? deps.attachOriginalLink(asset, outcome) : outcome;
}

function errorOutcome(
  asset: MediaAsset,
  code: MediaResultCode,
  retryable: boolean,
): MediaOutcome {
  return {
    result: {
      ...fallbackOutcome(asset, code, retryable).result,
      status: "error",
    },
  };
}
