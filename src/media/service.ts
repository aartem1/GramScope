import { randomUUID } from "node:crypto";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  GetMediaInput,
  GetMediaResult,
  MediaResultCode,
} from "../schemas/media";
import { INLINE_MEDIA_MAX_BYTES, MEDIA_RESULT_CODES } from "../schemas/media";
import { GramScopeError, mediaError } from "../errors/taxonomy";
import { loadConfig } from "../config";
import { normalizeImage } from "./image";
import {
  evenlySpacedTimestamps,
  mediaProcessor,
  normalizeRequestedTimestamps,
} from "./ffmpeg-processor";
import { safeMediaFilename } from "./names";
import { issueMediaToken } from "./token";
import {
  derivativeCache,
  derivativeKey,
  singleFlight,
  withVideoPermit,
  type CachedDerivative,
} from "./cache";
import { withTelegram, type TelegramLike } from "../telegram/client";
import {
  downloadAssetToFile,
  readAssetBytes,
  readAssetThumbnail,
  resolveMediaAsset,
  type MediaAsset,
} from "../telegram/media";

export type { MediaAsset } from "../telegram/media";

export const AUTO_VIDEO_MAX_BYTES = 64 * 1024 * 1024;
export const AUTO_VIDEO_DEADLINE_MS = 25_000;
export const FRAMES_VIDEO_MAX_BYTES = 128 * 1024 * 1024;
export const FRAMES_VIDEO_DEADLINE_MS = 45_000;

const MEDIA_RESULT_CODE_SET = new Set<string>(MEDIA_RESULT_CODES);

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
  derivativeCache?: Pick<typeof derivativeCache, "get" | "set">;
  derivativePath?: () => string;
  writeDerivative?: (path: string, data: Buffer) => Promise<void>;
  removeDerivative?: (path: string) => Promise<void>;
};

const productionMediaDependencies: MediaDependencies = {
  withClient: withTelegram,
  resolveAsset: resolveMediaAsset,
  readBytes: readAssetBytes,
  readThumbnail: readAssetThumbnail,
  normalizeImage,
  attachOriginalLink,
  downloadToFile: downloadAssetToFile,
  probeDuration: (inputPath, deadline) => mediaProcessor.probeDuration(inputPath, deadline),
  contactSheet: (inputPath, request) => mediaProcessor.contactSheet(inputPath, request),
  derivativeCache,
  derivativePath: () => join(tmpdir(), `gramscope-derivative-${randomUUID()}`),
  writeDerivative: async (path, data) => {
    await writeFile(path, data, { flag: "wx", mode: 0o600 });
  },
  removeDerivative: async (path) => {
    await rm(path, { force: true });
  },
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
      ? directImage(client, asset, deps, true, "preview")
      : thumbnailFallback(client, asset, deps);
  }
  if (mode === "frames") {
    if (!["video", "gif", "video_note"].includes(asset.descriptor.type)) {
      const unsupported = errorOutcome(asset, "UNSUPPORTED_MEDIA", false);
      return isDirectAudio(asset)
        ? withOriginalLink(asset, unsupported, deps)
        : unsupported;
    }
    return videoContactSheet(client, asset, input, deps, true);
  }

  switch (asset.descriptor.type) {
    case "photo":
      return directImage(client, asset, deps, true, "auto");
    case "voice":
    case "audio":
      return directAudioOrFallback(client, asset, deps);
    case "video":
    case "gif":
    case "video_note":
      return videoContactSheet(client, asset, input, deps, false);
    case "sticker":
    case "document":
      return asset.descriptor.mime_type?.startsWith("image/")
        ? directImage(client, asset, deps, true, "auto")
        : thumbnailFallback(client, asset, deps);
    default:
      return errorOutcome(asset, "UNSUPPORTED_MEDIA", false);
  }
}

async function videoContactSheet(
  client: TelegramLike,
  asset: MediaAsset,
  input: GetMediaInput,
  deps: MediaDependencies,
  explicitFrames: boolean,
): Promise<MediaOutcome> {
  const maxBytes = explicitFrames ? FRAMES_VIDEO_MAX_BYTES : AUTO_VIDEO_MAX_BYTES;
  const deadlineMs = explicitFrames ? FRAMES_VIDEO_DEADLINE_MS : AUTO_VIDEO_DEADLINE_MS;
  const keyTimestamps = input.timestamps_seconds
    ?.map((value) => Math.round(value * 1000) / 1000)
    .sort((a, b) => a - b);
  const key = derivativeKey({
    mediaId: asset.descriptor.media_id,
    mode: explicitFrames ? "frames" : "auto",
    timestampsSeconds: keyTimestamps,
    maxFrames: input.max_frames,
    processorVersion: "contact-sheet-v1",
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  timer.unref?.();
  try {
    const processed = await derivativeResult(key, async () => {
      if (controller.signal.aborted) {
        throw mediaError("PROCESSING_TIMEOUT", "Video processing exceeded its deadline", true);
      }
      if (asset.descriptor.size !== undefined && asset.descriptor.size > maxBytes) {
        throw mediaError(
          "INLINE_LIMIT_EXCEEDED",
          "Video exceeds its processing byte limit",
          false,
        );
      }
      if (!deps.downloadToFile || !deps.probeDuration || !deps.contactSheet) {
        throw mediaError("UNSUPPORTED_MEDIA", "Video processing is unavailable", false);
      }
      return generateVideoDerivative(
        client,
        asset,
        input,
        deps,
        maxBytes,
        deadlineMs,
        controller.signal,
      );
    }, deps, true);
    if (controller.signal.aborted) {
      throw mediaError("PROCESSING_TIMEOUT", "Video processing exceeded its deadline", true);
    }
    const outcome = readyOutcome(asset, {
      type: "image",
      data: processed.data,
      mimeType: processed.mimeType,
    });
    outcome.result.representation = {
      ...outcome.result.representation!,
      width: processed.width,
      height: processed.height,
      frame_count: processed.frameCount,
      timestamps_seconds: processed.timestampsSeconds,
    };
    return outcome;
  } catch (error) {
    if (!(error instanceof GramScopeError)) throw error;
    if (!MEDIA_RESULT_CODE_SET.has(error.code)) throw error;
    const code = error.code as MediaResultCode;
    return explicitFrames
      ? errorOutcome(asset, code, error.retryable)
      : thumbnailFallback(
        client,
        asset,
        deps,
        code,
        error.retryable,
      );
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function generateVideoDerivative(
  client: TelegramLike,
  asset: MediaAsset,
  input: GetMediaInput,
  deps: MediaDependencies,
  maxBytes: number,
  deadlineMs: number,
  deadline: AbortSignal,
): Promise<GeneratedDerivative> {
  let directory: string | undefined;
  try {
    if (deadline.aborted) {
      throw mediaError("PROCESSING_TIMEOUT", "Video processing exceeded its deadline", true);
    }
    directory = await mkdtemp(join(tmpdir(), "gramscope-video-"));
    const inputPath = join(directory, "input.bin");
    await deps.downloadToFile!(client, asset, {
      path: inputPath,
      maxBytes,
      deadlineMs,
      signal: deadline,
    });
    if (deadline.aborted) {
      throw mediaError("PROCESSING_TIMEOUT", "Video processing exceeded its deadline", true);
    }
    const declaredDuration = asset.descriptor.duration_seconds;
    const duration = declaredDuration !== undefined && declaredDuration > 0
      ? declaredDuration
      : await deps.probeDuration!(inputPath, deadline);
    const timestamps = input.timestamps_seconds?.length
      ? normalizeRequestedTimestamps(input.timestamps_seconds, duration)
      : evenlySpacedTimestamps(duration, input.max_frames);
    const processed = await deps.contactSheet!(inputPath, {
      timestampsSeconds: timestamps,
      maxBytes: INLINE_MEDIA_MAX_BYTES,
      maxLongEdge: 1600,
      deadline,
    });
    if (deadline.aborted) {
      throw mediaError("PROCESSING_TIMEOUT", "Video processing exceeded its deadline", true);
    }
    if (processed.data.length > INLINE_MEDIA_MAX_BYTES) {
      throw mediaError("INLINE_LIMIT_EXCEEDED", "Contact sheet exceeds the inline media limit", false);
    }
    return processed;
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
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
  cacheMode?: string,
): Promise<MediaOutcome> {
  try {
    return await directImageOnce(client, asset, deps, cacheMode);
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
  cacheMode?: string,
): Promise<MediaOutcome> {
  const generate = async () => {
    const thumbnail = await deps.readThumbnail?.(client, asset, INLINE_MEDIA_MAX_BYTES);
    if (!thumbnail && (asset.descriptor.size ?? INLINE_MEDIA_MAX_BYTES + 1) > INLINE_MEDIA_MAX_BYTES) {
      throw new GramScopeError(
        "INLINE_LIMIT_EXCEEDED",
        "Image source exceeds the inline media limit and has no bounded thumbnail",
      );
    }
    const source = thumbnail?.data ?? await deps.readBytes(client, asset, INLINE_MEDIA_MAX_BYTES);
    return normalizeImageArtifact(
      asset,
      source,
      thumbnail?.mimeType ?? asset.descriptor.mime_type,
      deps,
    );
  };
  const processed = cacheMode
    ? await derivativeResult(derivativeKey({
      mediaId: asset.descriptor.media_id,
      mode: cacheMode,
      maxFrames: 1,
      processorVersion: "normalized-image-v1",
    }), generate, deps, false)
    : await generate();
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
  code: MediaResultCode = "UNSUPPORTED_MEDIA",
  retryable = false,
): Promise<MediaOutcome> {
  try {
    const processed = await derivativeResult(derivativeKey({
      mediaId: asset.descriptor.media_id,
      mode: "thumbnail",
      maxFrames: 1,
      processorVersion: "normalized-image-v1",
    }), async () => {
      const thumbnail = await deps.readThumbnail?.(client, asset, INLINE_MEDIA_MAX_BYTES);
      if (!thumbnail) return undefined;
      return normalizeImageArtifact(asset, thumbnail.data, thumbnail.mimeType, deps);
    }, deps, false);
    const base = fallbackOutcome(asset, code, retryable);
    if (processed) {
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

type GeneratedDerivative = {
  data: Buffer;
  mimeType: string;
  width: number;
  height: number;
  frameCount?: number;
  timestampsSeconds?: number[];
};

async function readCachedDerivative(
  cached: CachedDerivative,
): Promise<GeneratedDerivative | undefined> {
  if (cached.bytes > INLINE_MEDIA_MAX_BYTES) {
    throw mediaError("INLINE_LIMIT_EXCEEDED", "Cached derivative exceeds the inline limit", false);
  }
  let handle;
  try {
    handle = await open(cached.path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (stats.size !== cached.bytes || stats.size > INLINE_MEDIA_MAX_BYTES) {
      throw mediaError("INLINE_LIMIT_EXCEEDED", "Cached derivative size is invalid", false);
    }
    const data = Buffer.alloc(cached.bytes);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (bytesRead === 0) return undefined;
      offset += bytesRead;
    }
    return {
      data,
      mimeType: cached.mimeType,
      width: cached.width,
      height: cached.height,
      ...(cached.frameCount !== undefined ? { frameCount: cached.frameCount } : {}),
      ...(cached.timestampsSeconds
        ? { timestampsSeconds: [...cached.timestampsSeconds] }
        : {}),
    };
  } finally {
    await handle.close();
  }
}

async function derivativeResult(
  key: string,
  generate: () => Promise<GeneratedDerivative>,
  deps: MediaDependencies,
  video: boolean,
): Promise<GeneratedDerivative>;
async function derivativeResult(
  key: string,
  generate: () => Promise<GeneratedDerivative | undefined>,
  deps: MediaDependencies,
  video: boolean,
): Promise<GeneratedDerivative | undefined>;
async function derivativeResult(
  key: string,
  generate: () => Promise<GeneratedDerivative | undefined>,
  deps: MediaDependencies,
  video: boolean,
): Promise<GeneratedDerivative | undefined> {
  const cache = deps.derivativeCache;
  if (!cache) {
    return video ? withVideoPermit(generate) : generate();
  }

  const cached = await cache.get(key);
  if (cached) {
    const materialized = await readCachedDerivative(cached);
    if (materialized) return materialized;
  }

  const stored = await singleFlight(key, async () => {
    const raced = await cache.get(key);
    if (raced) return raced;

    const generated = await (video ? withVideoPermit(generate) : generate());
    if (!generated) return undefined;
    if (generated.data.length > INLINE_MEDIA_MAX_BYTES) {
      throw mediaError("INLINE_LIMIT_EXCEEDED", "Derivative exceeds the inline media limit", false);
    }
    const path = deps.derivativePath!();
    let transferred = false;
    try {
      await deps.writeDerivative!(path, generated.data);
      const value: CachedDerivative = {
        path,
        bytes: generated.data.length,
        mimeType: generated.mimeType,
        width: generated.width,
        height: generated.height,
        ...(generated.frameCount !== undefined ? { frameCount: generated.frameCount } : {}),
        ...(generated.timestampsSeconds
          ? { timestampsSeconds: [...generated.timestampsSeconds] }
          : {}),
      };
      await cache.set(key, value);
      transferred = true;
      return value;
    } finally {
      if (!transferred) await deps.removeDerivative!(path);
    }
  });

  return stored ? readCachedDerivative(stored) : undefined;
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
