import { randomUUID } from "node:crypto";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GramScopeError, mediaError } from "../errors/taxonomy";
import { INLINE_MEDIA_MAX_BYTES } from "../schemas/media";
import { type TelegramLike } from "../telegram/client";
import {
  downloadAssetToFile,
  readAssetBytes,
  readAssetThumbnail,
  type MediaAsset,
} from "../telegram/media";
import {
  derivativeCache,
  derivativeKey,
  singleFlight,
  withVideoPermit,
  type CachedDerivative,
} from "./cache";
import {
  evenlySpacedTimestamps,
  mediaProcessor,
  normalizeRequestedTimestamps,
} from "./ffmpeg-processor";
import { normalizeImage } from "./image";
import type { MediaRepresentationPlan } from "./representation";

export const AUTO_VIDEO_MAX_BYTES = 64 * 1024 * 1024;
export const AUTO_VIDEO_DEADLINE_MS = 25_000;
export const FRAMES_VIDEO_MAX_BYTES = 128 * 1024 * 1024;
export const FRAMES_VIDEO_DEADLINE_MS = 45_000;
export const FALLBACK_IMAGE_DEADLINE_MS = 5_000;

export type GeneratedMediaView = {
  data: Buffer;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
  frameCount?: number;
  timestampsSeconds?: number[];
};

type Thumbnail = {
  data: Buffer;
  mimeType: string;
};

export type MaterializerDependencies = {
  readBytes(
    client: TelegramLike,
    asset: MediaAsset,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Buffer>;
  readThumbnail(
    client: TelegramLike,
    asset: MediaAsset,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Thumbnail | undefined>;
  normalizeImage(
    source: Buffer,
    options: {
      preserveTransparency?: boolean;
      sourceMimeType?: string;
      maxBytes: number;
      maxLongEdge: number;
      deadline?: AbortSignal;
    },
  ): Promise<GeneratedMediaView>;
  downloadToFile(
    client: TelegramLike,
    asset: MediaAsset,
    options: { path: string; maxBytes: number; deadlineMs: number; signal?: AbortSignal },
  ): Promise<number>;
  probeDuration(inputPath: string, deadline: AbortSignal): Promise<number>;
  contactSheet(inputPath: string, request: {
    timestampsSeconds: number[];
    maxBytes: number;
    maxLongEdge: number;
    deadline: AbortSignal;
  }): Promise<GeneratedMediaView>;
  derivativeCache: Pick<typeof derivativeCache, "get" | "set"> | undefined;
  derivativePath(): string;
  writeDerivative(path: string, data: Buffer): Promise<void>;
  removeDerivative(path: string): Promise<void>;
};

const productionMaterializerDependencies: MaterializerDependencies = {
  readBytes: readAssetBytes,
  readThumbnail: readAssetThumbnail,
  normalizeImage,
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

export async function materializeMediaView(
  client: TelegramLike,
  asset: MediaAsset,
  plan: Exclude<MediaRepresentationPlan, { kind: "original" }>,
  overrides: Partial<MaterializerDependencies> = {},
): Promise<GeneratedMediaView> {
  const deps = { ...productionMaterializerDependencies, ...overrides };
  if (plan.kind === "image") {
    return materializeImageView(client, asset, plan, deps);
  }
  return materializeContactSheetView(client, asset, plan, deps);
}

async function materializeImageView(
  client: TelegramLike,
  asset: MediaAsset,
  plan: Extract<MediaRepresentationPlan, { kind: "image" }>,
  deps: MaterializerDependencies,
): Promise<GeneratedMediaView> {
  const thumbnail = await deps.readThumbnail(client, asset, INLINE_MEDIA_MAX_BYTES);
  if (plan.source === "thumbnail" && !thumbnail) {
    throw mediaError("UNSUPPORTED_MEDIA", "No image preview is available", false);
  }
  const data = thumbnail?.data ?? await deps.readBytes(client, asset, INLINE_MEDIA_MAX_BYTES);
  return deps.normalizeImage(data, {
    preserveTransparency: asset.descriptor.mime_type === "image/png" ||
      asset.descriptor.mime_type === "image/webp",
    sourceMimeType: thumbnail?.mimeType ?? asset.descriptor.mime_type,
    maxBytes: INLINE_MEDIA_MAX_BYTES,
    maxLongEdge: 1600,
  });
}

async function materializeContactSheetView(
  client: TelegramLike,
  asset: MediaAsset,
  plan: Extract<MediaRepresentationPlan, { kind: "contact_sheet" }>,
  deps: MaterializerDependencies,
): Promise<GeneratedMediaView> {
  const maxBytes = plan.mode === "frames" ? FRAMES_VIDEO_MAX_BYTES : AUTO_VIDEO_MAX_BYTES;
  const deadlineMs = plan.mode === "frames" ? FRAMES_VIDEO_DEADLINE_MS : AUTO_VIDEO_DEADLINE_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  timer.unref?.();
  try {
    const key = derivativeKey({
      mediaId: asset.descriptor.media_id,
      mode: plan.mode,
      timestampsSeconds: plan.timestampsSeconds,
      maxFrames: plan.maxFrames,
      processorVersion: "contact-sheet-v1",
    });
    return await derivativeResult(key, () => generateVideoDerivative(
      client,
      asset,
      plan,
      deps,
      maxBytes,
      deadlineMs,
      controller.signal,
    ), deps, true, controller.signal);
  } catch (error) {
    if (plan.mode === "auto" && error instanceof GramScopeError) {
      const fallbackDeadline = AbortSignal.timeout(FALLBACK_IMAGE_DEADLINE_MS);
      const thumbnail = await deps.readThumbnail(
        client,
        asset,
        INLINE_MEDIA_MAX_BYTES,
        fallbackDeadline,
      );
      if (thumbnail) {
        return deps.normalizeImage(thumbnail.data, {
          sourceMimeType: thumbnail.mimeType,
          maxBytes: INLINE_MEDIA_MAX_BYTES,
          maxLongEdge: 1600,
          deadline: fallbackDeadline,
        });
      }
    }
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function generateVideoDerivative(
  client: TelegramLike,
  asset: MediaAsset,
  plan: Extract<MediaRepresentationPlan, { kind: "contact_sheet" }>,
  deps: MaterializerDependencies,
  maxBytes: number,
  deadlineMs: number,
  deadline: AbortSignal,
): Promise<GeneratedMediaView> {
  let directory: string | undefined;
  try {
    if (deadline.aborted) {
      throw mediaError("PROCESSING_TIMEOUT", "Video processing exceeded its deadline", true);
    }
    if (asset.descriptor.size !== undefined && asset.descriptor.size > maxBytes) {
      throw mediaError(
        "INLINE_LIMIT_EXCEEDED",
        "Video exceeds its generated representation byte limit",
        false,
      );
    }
    directory = await mkdtemp(join(tmpdir(), "gramscope-video-"));
    const inputPath = join(directory, "input.bin");
    await deps.downloadToFile(client, asset, {
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
      : await deps.probeDuration(inputPath, deadline);
    const timestamps = plan.timestampsSeconds?.length
      ? normalizeRequestedTimestamps(plan.timestampsSeconds, duration)
      : evenlySpacedTimestamps(duration, plan.maxFrames);
    const processed = await deps.contactSheet(inputPath, {
      timestampsSeconds: timestamps,
      maxBytes: INLINE_MEDIA_MAX_BYTES,
      maxLongEdge: 1600,
      deadline,
    });
    if (deadline.aborted) {
      throw mediaError("PROCESSING_TIMEOUT", "Video processing exceeded its deadline", true);
    }
    if (processed.data.length > INLINE_MEDIA_MAX_BYTES) {
      throw mediaError(
        "INLINE_LIMIT_EXCEEDED",
        "Contact sheet exceeds the generated representation limit",
        false,
      );
    }
    return processed;
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

async function readCachedDerivative(
  cached: CachedDerivative,
): Promise<GeneratedMediaView | undefined> {
  if (cached.bytes > INLINE_MEDIA_MAX_BYTES) {
    throw mediaError(
      "INLINE_LIMIT_EXCEEDED",
      "Cached derivative exceeds the generated representation limit",
      false,
    );
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
      throw mediaError(
        "INLINE_LIMIT_EXCEEDED",
        "Cached derivative size is invalid",
        false,
      );
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
      mimeType: cached.mimeType as GeneratedMediaView["mimeType"],
      width: cached.width,
      height: cached.height,
      ...(cached.frameCount !== undefined ? { frameCount: cached.frameCount } : {}),
      ...(cached.timestampsSeconds ? { timestampsSeconds: [...cached.timestampsSeconds] } : {}),
    };
  } finally {
    await handle.close();
  }
}

async function derivativeResult(
  key: string,
  generate: () => Promise<GeneratedMediaView>,
  deps: MaterializerDependencies,
  video: boolean,
  signal?: AbortSignal,
): Promise<GeneratedMediaView> {
  const cache = deps.derivativeCache;
  if (!cache) return video ? withVideoPermit(generate, signal) : generate();

  const cached = await cache.get(key);
  if (cached) {
    const materialized = await readCachedDerivative(cached);
    if (materialized) return materialized;
  }

  const stored = await singleFlight(key, async () => {
    const raced = await cache.get(key);
    if (raced) return raced;

    const generated = await (video ? withVideoPermit(generate, signal) : generate());
    if (generated.data.length > INLINE_MEDIA_MAX_BYTES) {
      throw mediaError(
        "INLINE_LIMIT_EXCEEDED",
        "Derivative exceeds the generated representation limit",
        false,
      );
    }
    const path = deps.derivativePath();
    let transferred = false;
    try {
      await deps.writeDerivative(path, generated.data);
      const value: CachedDerivative = {
        path,
        bytes: generated.data.length,
        mimeType: generated.mimeType,
        width: generated.width,
        height: generated.height,
        ...(generated.frameCount !== undefined ? { frameCount: generated.frameCount } : {}),
        ...(generated.timestampsSeconds ? { timestampsSeconds: [...generated.timestampsSeconds] } : {}),
      };
      await cache.set(key, value);
      transferred = true;
      return value;
    } finally {
      if (!transferred) await deps.removeDerivative(path);
    }
  });
  const materialized = await readCachedDerivative(stored);
  if (!materialized) {
    throw mediaError("INLINE_LIMIT_EXCEEDED", "Cached derivative is unavailable", false);
  }
  return materialized;
}
