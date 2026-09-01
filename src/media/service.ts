import { loadConfig } from "../config";
import { GramScopeError } from "../errors/taxonomy";
import {
  DEFAULT_MAX_FRAMES,
  INLINE_MEDIA_MAX_BYTES,
  MEDIA_RESULT_CODES,
  type GetMediaInput,
  type GetMediaResult,
  type MediaResultCode,
} from "../schemas/media";
import { withTelegram, type TelegramLike } from "../telegram/client";
import { readAssetBytes, resolveMediaAsset, type MediaAsset } from "../telegram/media";
import {
  materializeMediaView,
  type GeneratedMediaView,
  type MaterializerDependencies,
} from "./materializer";
import { safeMediaFilename } from "./names";
import type { MediaRepresentationPlan } from "./representation";
import { issueMediaToken } from "./token";

export type { MediaAsset } from "../telegram/media";

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
  resolveAsset(
    client: TelegramLike,
    input: { sourceId: string; messageId: number },
  ): Promise<MediaAsset>;
  readBytes(
    client: TelegramLike,
    asset: MediaAsset,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Buffer>;
  materialize: typeof materializeMediaView;
  attachOriginalLink?: (asset: MediaAsset, outcome: MediaOutcome) => Promise<MediaOutcome>;
  readThumbnail?: MaterializerDependencies["readThumbnail"];
  normalizeImage?: MaterializerDependencies["normalizeImage"];
  downloadToFile?: MaterializerDependencies["downloadToFile"];
  probeDuration?: MaterializerDependencies["probeDuration"];
  contactSheet?: MaterializerDependencies["contactSheet"];
  derivativeCache?: MaterializerDependencies["derivativeCache"];
  derivativePath?: MaterializerDependencies["derivativePath"];
  writeDerivative?: MaterializerDependencies["writeDerivative"];
  removeDerivative?: MaterializerDependencies["removeDerivative"];
};

const productionMediaDependencies: MediaDependencies = {
  withClient: withTelegram,
  resolveAsset: resolveMediaAsset,
  readBytes: readAssetBytes,
  materialize: materializeMediaView,
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
      ? directImage(client, asset, deps, true)
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
      return directImage(client, asset, deps, true);
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
        ? directImage(client, asset, deps, true)
        : thumbnailFallback(client, asset, deps);
    default:
      return errorOutcome(asset, "UNSUPPORTED_MEDIA", false);
  }
}

function materializerOverrides(deps: MediaDependencies): Partial<MaterializerDependencies> {
  const overrides: Partial<MaterializerDependencies> = { readBytes: deps.readBytes };
  if (deps.readThumbnail) overrides.readThumbnail = deps.readThumbnail;
  if (deps.normalizeImage) overrides.normalizeImage = deps.normalizeImage;
  if (deps.downloadToFile) overrides.downloadToFile = deps.downloadToFile;
  if (deps.probeDuration) overrides.probeDuration = deps.probeDuration;
  if (deps.contactSheet) overrides.contactSheet = deps.contactSheet;
  if (deps.derivativePath) overrides.derivativePath = deps.derivativePath;
  if (deps.writeDerivative) overrides.writeDerivative = deps.writeDerivative;
  if (deps.removeDerivative) overrides.removeDerivative = deps.removeDerivative;
  if (Object.prototype.hasOwnProperty.call(deps, "derivativeCache")) {
    overrides.derivativeCache = deps.derivativeCache;
  }
  return overrides;
}

async function generateView(
  client: TelegramLike,
  asset: MediaAsset,
  plan: Exclude<MediaRepresentationPlan, { kind: "original" }>,
  deps: MediaDependencies,
  cache = true,
): Promise<GeneratedMediaView> {
  const overrides = materializerOverrides(deps);
  if (!cache) overrides.derivativeCache = undefined;
  return deps.materialize(client, asset, plan, overrides);
}

function generatedImageOutcome(asset: MediaAsset, generated: GeneratedMediaView): MediaOutcome {
  const outcome = readyOutcome(asset, {
    type: "image",
    data: generated.data,
    mimeType: generated.mimeType,
  });
  outcome.result.representation = {
    ...outcome.result.representation!,
    width: generated.width,
    height: generated.height,
    ...(generated.frameCount !== undefined ? { frame_count: generated.frameCount } : {}),
    ...(generated.timestampsSeconds
      ? { timestamps_seconds: [...generated.timestampsSeconds] }
      : {}),
  };
  return outcome;
}

function generatedFallbackOutcome(
  asset: MediaAsset,
  generated: GeneratedMediaView,
  code: MediaResultCode,
  retryable: boolean,
): MediaOutcome {
  const outcome = fallbackOutcome(asset, code, retryable);
  outcome.artifact = { type: "image", data: generated.data, mimeType: generated.mimeType };
  outcome.result.representation = {
    kind: "image",
    mime_type: generated.mimeType,
    byte_size: generated.data.length,
    width: generated.width,
    height: generated.height,
  };
  return outcome;
}

async function videoContactSheet(
  client: TelegramLike,
  asset: MediaAsset,
  input: GetMediaInput,
  deps: MediaDependencies,
  explicitFrames: boolean,
): Promise<MediaOutcome> {
  const plan: Exclude<MediaRepresentationPlan, { kind: "original" | "image" }> = {
    kind: "contact_sheet",
    mode: explicitFrames ? "frames" : "auto",
    maxFrames: explicitFrames ? input.max_frames : DEFAULT_MAX_FRAMES,
    ...(input.timestamps_seconds?.length
      ? { timestampsSeconds: [...input.timestamps_seconds].sort((a, b) => a - b) }
      : {}),
  };
  try {
    const generated = await generateView(client, asset, plan, deps);
    if (generated.fallback) {
      if (!MEDIA_RESULT_CODE_SET.has(generated.fallback.code)) {
        throw new GramScopeError(generated.fallback.code, "Unsupported fallback code");
      }
      return withOriginalLink(
        asset,
        generatedFallbackOutcome(
          asset,
          generated,
          generated.fallback.code as MediaResultCode,
          generated.fallback.retryable,
        ),
        deps,
      );
    }
    return generatedImageOutcome(asset, generated);
  } catch (error) {
    if (!(error instanceof GramScopeError) || !MEDIA_RESULT_CODE_SET.has(error.code)) throw error;
    const code = error.code as MediaResultCode;
    return explicitFrames
      ? errorOutcome(asset, code, error.retryable)
      : withOriginalLink(asset, fallbackOutcome(asset, code, error.retryable), deps);
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
  if (isDirectImage(asset)) return directImage(client, asset, deps, false, false);
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
  cache = true,
): Promise<MediaOutcome> {
  try {
    const generated = await generateView(
      client,
      asset,
      { kind: "image", source: "auto" },
      deps,
      cache,
    );
    return generatedImageOutcome(asset, generated);
  } catch (error) {
    if (!(error instanceof GramScopeError) || error.code !== "INLINE_LIMIT_EXCEEDED") throw error;
    const fallback = fallbackOutcome(asset, "INLINE_LIMIT_EXCEEDED", false);
    return attachLinkOnFallback ? withOriginalLink(asset, fallback, deps) : fallback;
  }
}

async function thumbnailFallback(
  client: TelegramLike,
  asset: MediaAsset,
  deps: MediaDependencies,
  code: MediaResultCode = "UNSUPPORTED_MEDIA",
  retryable = false,
): Promise<MediaOutcome> {
  try {
    const generated = await generateView(
      client,
      asset,
      { kind: "image", source: "thumbnail" },
      deps,
    );
    return withOriginalLink(
      asset,
      generatedFallbackOutcome(asset, generated, code, retryable),
      deps,
    );
  } catch (error) {
    if (error instanceof GramScopeError && error.code === "UNSUPPORTED_MEDIA") {
      return withOriginalLink(asset, fallbackOutcome(asset, code, retryable), deps);
    }
    if (error instanceof GramScopeError && error.code === "INLINE_LIMIT_EXCEEDED") {
      return withOriginalLink(
        asset,
        fallbackOutcome(asset, "INLINE_LIMIT_EXCEEDED", false),
        deps,
      );
    }
    throw error;
  }
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
