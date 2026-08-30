import type {
  GetMediaInput,
  GetMediaResult,
  MediaDescriptor,
  MediaResultCode,
} from "../schemas/media";
import { INLINE_MEDIA_MAX_BYTES } from "../schemas/media";
import { withTelegram, type TelegramLike } from "../telegram/client";
import { readAssetBytes, resolveMediaAsset } from "../telegram/media";

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

export type MediaAsset = {
  sourceId: string;
  messageId: number;
  sourceHandle: string;
  descriptor: MediaDescriptor;
  rawMessage: Record<string, unknown>;
  rawMedia: Record<string, unknown>;
  thumbnailLocation?: unknown;
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
};

function readyOutcome(asset: MediaAsset, artifact: MediaArtifact): MediaOutcome {
  const fileName = asset.descriptor.file_name;
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
    if ((asset.descriptor.size ?? INLINE_MEDIA_MAX_BYTES + 1) > INLINE_MEDIA_MAX_BYTES) {
      return fallbackOutcome(asset, "INLINE_LIMIT_EXCEEDED", false);
    }
    if (!["photo", "voice", "audio"].includes(asset.descriptor.type)) {
      return fallbackOutcome(asset, "UNSUPPORTED_MEDIA", false);
    }
    const data = await deps.readBytes(client, asset, INLINE_MEDIA_MAX_BYTES);
    return readyOutcome(asset, {
      type: asset.descriptor.type === "photo" ? "image" : "audio",
      data,
      mimeType: asset.descriptor.mime_type ?? (asset.descriptor.type === "photo" ? "image/jpeg" : "audio/ogg"),
    });
  });
}
