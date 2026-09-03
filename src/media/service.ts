import { loadConfig } from "../config";
import { GramScopeError } from "../errors/taxonomy";
import {
  MEDIA_RESULT_CODES,
  type GetMediaInput,
  type MediaDescriptor,
  type GetMediaResult,
  type MediaResultCode,
} from "../schemas/media";
import { withTelegram, type TelegramLike } from "../telegram/client";
import { resolveMediaAsset, type MediaAsset } from "../telegram/media";
import { safeMediaFilename } from "./names";
import { planMediaRepresentation, type MediaRepresentationPlan } from "./representation";
import {
  issueMediaCapability,
  type MediaCapabilityClaims,
  type UnsignedMediaClaims,
} from "./token";

export type { MediaAsset } from "../telegram/media";
export type { UnsignedMediaClaims };

const MEDIA_RESULT_CODE_SET = new Set<string>(MEDIA_RESULT_CODES);
const MAX_MEDIA_ID_BYTES = 256;
const MAX_MEDIA_TYPE_BYTES = 64;
const MAX_MEDIA_FILENAME_BYTES = 160;
const MAX_MEDIA_MIME_BYTES = 128;

export type MediaLink = {
  /** Present after Vercel seals the capability; absent on worker drafts. */
  uri?: string;
  name: string;
  mimeType?: string;
  size?: number;
};

export type MediaOutcome = {
  result: GetMediaResult;
  link?: MediaLink;
  /** Worker→Vercel only; stripped when the capability is sealed. */
  unsignedClaims?: UnsignedMediaClaims;
};

export type MediaDependencies = {
  withClient<T>(run: (client: TelegramLike) => Promise<T>): Promise<T>;
  resolveAsset(
    client: TelegramLike,
    input: { sourceId: string; messageId: number },
  ): Promise<MediaAsset>;
  issueCapability(
    claims: MediaCapabilityClaims,
  ): Promise<{ token: string; expiresAt: Date }>;
  mediaOrigin: string;
  ownerId: string;
};

export type MediaPlanDependencies = Pick<
  MediaDependencies,
  "withClient" | "resolveAsset"
>;

export type MediaFinalizeDependencies = Pick<
  MediaDependencies,
  "issueCapability" | "mediaOrigin" | "ownerId"
>;

function productionMediaDependencies(): MediaDependencies {
  const config = loadConfig();
  return {
    withClient: withTelegram,
    resolveAsset: resolveMediaAsset,
    issueCapability: (claims) => issueMediaCapability(claims, new Date(), config.mediaTokenSecret),
    mediaOrigin: new URL(config.mcpResourceUrl).origin,
    ownerId: config.ownerUserId,
  };
}

function productionPlanDependencies(): MediaPlanDependencies {
  return {
    withClient: withTelegram,
    resolveAsset: resolveMediaAsset,
  };
}

function completeOverrides(overrides: Partial<MediaDependencies>): overrides is MediaDependencies {
  return overrides.withClient !== undefined &&
    overrides.resolveAsset !== undefined &&
    overrides.issueCapability !== undefined &&
    overrides.mediaOrigin !== undefined &&
    overrides.ownerId !== undefined;
}

/**
 * Telegram half of get_media: resolve + plan, no MEDIA_TOKEN_SECRET.
 * Used by the worker so capability minting stays on Vercel.
 */
export async function planGetMedia(
  input: GetMediaInput,
  overrides: Partial<MediaPlanDependencies> = {},
): Promise<MediaOutcome> {
  const deps = {
    ...productionPlanDependencies(),
    ...overrides,
  };
  return deps.withClient(async (client) => {
    const asset = await deps.resolveAsset(client, {
      sourceId: input.source_id,
      messageId: input.message_id,
    });
    let plan: MediaRepresentationPlan;
    try {
      plan = planMediaRepresentation(asset, input);
    } catch (error) {
      if (!(error instanceof GramScopeError) || !MEDIA_RESULT_CODE_SET.has(error.code)) {
        throw error;
      }
      return errorOutcome(asset, error.code as MediaResultCode, error.retryable);
    }
    return draftLink(asset, plan);
  });
}

export async function getMedia(
  input: GetMediaInput,
  overrides: Partial<MediaDependencies> = {},
): Promise<MediaOutcome> {
  const deps = completeOverrides(overrides)
    ? overrides
    : { ...productionMediaDependencies(), ...overrides };
  const draft = await planGetMedia(input, {
    withClient: deps.withClient,
    resolveAsset: deps.resolveAsset,
  });
  if (!draft.unsignedClaims) return draft;
  return finalizeMediaOutcome(draft, deps);
}

export async function finalizeMediaOutcome(
  draft: MediaOutcome,
  deps: MediaFinalizeDependencies,
): Promise<MediaOutcome> {
  const claims = draft.unsignedClaims;
  if (!claims) {
    throw new GramScopeError(
      "INTERNAL_ERROR",
      "Cannot finalize a media outcome without unsignedClaims.",
    );
  }
  if (!draft.link) {
    throw new GramScopeError(
      "INTERNAL_ERROR",
      "Cannot finalize a media outcome without link metadata.",
    );
  }

  const issued = await deps.issueCapability({
    ...claims,
    ownerId: deps.ownerId,
  });
  const isOriginal = claims.representation.kind === "original";
  const uri = new URL(
    isOriginal
      ? `/api/media/${encodeURIComponent(issued.token)}`
      : `/api/media/view/${encodeURIComponent(issued.token)}`,
    deps.mediaOrigin,
  ).toString();

  return {
    result: {
      ...draft.result,
      download: {
        url: uri,
        expires_at: issued.expiresAt.toISOString(),
      },
    },
    link: {
      ...draft.link,
      uri,
    },
  };
}

function draftLink(
  asset: MediaAsset,
  plan: MediaRepresentationPlan,
): MediaOutcome {
  const isOriginal = plan.kind === "original";
  const descriptor = compactDescriptor(asset.descriptor);
  const unsignedClaims: UnsignedMediaClaims = {
    v: 2,
    purpose: "telegram-media",
    sourceId: asset.sourceId,
    messageId: asset.messageId,
    representation: isOriginal && descriptor.size !== undefined
      ? { kind: "original", byteSize: descriptor.size }
      : plan,
  };
  const mimeType = isOriginal
    ? descriptor.mime_type
    : plan.kind === "contact_sheet" ? "image/jpeg" : undefined;
  const name = isOriginal
    ? safeMediaFilename({
      supplied: descriptor.file_name,
      kind: descriptor.type,
      messageId: asset.messageId,
      mimeType,
    })
    : plan.kind === "contact_sheet"
      ? `contact-sheet-${asset.messageId}.jpg`
      : `preview-${asset.messageId}`;
  const representationKind = isOriginal
    ? originalRepresentationKind(asset)
    : "image";

  return {
    result: {
      status: "ready",
      source_id: asset.sourceId,
      message_id: asset.messageId,
      media: descriptor,
      representation: {
        kind: representationKind,
        delivery: "resource_link",
        ...(mimeType ? { mime_type: mimeType } : {}),
        file_name: name,
        ...(isOriginal && descriptor.size !== undefined
          ? { byte_size: descriptor.size }
          : {}),
      },
    },
    link: {
      name,
      ...(mimeType ? { mimeType } : {}),
      ...(isOriginal && descriptor.size !== undefined ? { size: descriptor.size } : {}),
    },
    unsignedClaims,
  };
}

function compactUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let compact = "";
  for (const symbol of value) {
    const symbolBytes = Buffer.byteLength(symbol, "utf8");
    if (bytes + symbolBytes > maxBytes) break;
    compact += symbol;
    bytes += symbolBytes;
  }
  return compact;
}

function compactDescriptor(descriptor: MediaDescriptor): MediaDescriptor {
  return {
    media_id: compactUtf8(descriptor.media_id, MAX_MEDIA_ID_BYTES),
    type: compactUtf8(descriptor.type, MAX_MEDIA_TYPE_BYTES),
    ...(descriptor.file_name !== undefined
      ? { file_name: compactUtf8(descriptor.file_name, MAX_MEDIA_FILENAME_BYTES) }
      : {}),
    ...(descriptor.mime_type !== undefined
      ? { mime_type: compactUtf8(descriptor.mime_type, MAX_MEDIA_MIME_BYTES) }
      : {}),
    ...(descriptor.size !== undefined ? { size: descriptor.size } : {}),
    ...(descriptor.width !== undefined ? { width: descriptor.width } : {}),
    ...(descriptor.height !== undefined ? { height: descriptor.height } : {}),
    ...(descriptor.duration_seconds !== undefined
      ? { duration_seconds: descriptor.duration_seconds }
      : {}),
    ...(descriptor.has_thumbnail !== undefined
      ? { has_thumbnail: descriptor.has_thumbnail }
      : {}),
  };
}

function originalRepresentationKind(asset: MediaAsset): "audio" | "document" | "image" | "download" {
  if (["voice", "audio"].includes(asset.descriptor.type)) return "audio";
  if (asset.descriptor.type === "document") return "document";
  if (asset.descriptor.type === "photo" || asset.descriptor.mime_type?.startsWith("image/")) {
    return "image";
  }
  return "download";
}

function errorOutcome(
  asset: MediaAsset,
  code: MediaResultCode,
  retryable: boolean,
): MediaOutcome {
  return {
    result: {
      status: "error",
      source_id: asset.sourceId,
      message_id: asset.messageId,
      media: compactDescriptor(asset.descriptor),
      representation: { kind: "metadata" },
      code,
      retryable,
      message: "No supported media representation is available.",
    },
  };
}
