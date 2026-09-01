import { loadConfig } from "../config";
import { GramScopeError } from "../errors/taxonomy";
import {
  MEDIA_RESULT_CODES,
  type GetMediaInput,
  type GetMediaResult,
  type MediaResultCode,
} from "../schemas/media";
import { withTelegram, type TelegramLike } from "../telegram/client";
import { resolveMediaAsset, type MediaAsset } from "../telegram/media";
import { safeMediaFilename } from "./names";
import { planMediaRepresentation, type MediaRepresentationPlan } from "./representation";
import { issueMediaCapability, type MediaCapabilityClaims } from "./token";

export type { MediaAsset } from "../telegram/media";

const MEDIA_RESULT_CODE_SET = new Set<string>(MEDIA_RESULT_CODES);

export type MediaLink = {
  uri: string;
  name: string;
  mimeType?: string;
  size?: number;
};

export type MediaOutcome = {
  result: GetMediaResult;
  link?: MediaLink;
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

function completeOverrides(overrides: Partial<MediaDependencies>): overrides is MediaDependencies {
  return overrides.withClient !== undefined &&
    overrides.resolveAsset !== undefined &&
    overrides.issueCapability !== undefined &&
    overrides.mediaOrigin !== undefined &&
    overrides.ownerId !== undefined;
}

export async function getMedia(
  input: GetMediaInput,
  overrides: Partial<MediaDependencies> = {},
): Promise<MediaOutcome> {
  const deps = completeOverrides(overrides)
    ? overrides
    : { ...productionMediaDependencies(), ...overrides };
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
    return issueLink(asset, plan, deps);
  });
}

async function issueLink(
  asset: MediaAsset,
  plan: MediaRepresentationPlan,
  deps: MediaDependencies,
): Promise<MediaOutcome> {
  const issued = await deps.issueCapability({
    v: 2,
    purpose: "telegram-media",
    sourceId: asset.sourceId,
    messageId: asset.messageId,
    ownerId: deps.ownerId,
    representation: plan,
  });
  const isOriginal = plan.kind === "original";
  const uri = new URL(
    isOriginal
      ? `/api/media/${encodeURIComponent(issued.token)}`
      : `/api/media/view/${encodeURIComponent(issued.token)}`,
    deps.mediaOrigin,
  ).toString();
  const mimeType = isOriginal ? asset.descriptor.mime_type : "image/jpeg";
  const name = safeMediaFilename({
    supplied: asset.descriptor.file_name,
    kind: isOriginal ? asset.descriptor.type : "preview",
    messageId: asset.messageId,
    mimeType,
  });
  const representationKind = isOriginal
    ? originalRepresentationKind(asset)
    : "image";

  return {
    result: {
      status: "ready",
      source_id: asset.sourceId,
      message_id: asset.messageId,
      media: asset.descriptor,
      representation: {
        kind: representationKind,
        delivery: "resource_link",
        ...(mimeType ? { mime_type: mimeType } : {}),
        file_name: name,
        ...(isOriginal && asset.descriptor.size !== undefined
          ? { byte_size: asset.descriptor.size }
          : {}),
      },
      download: {
        url: uri,
        expires_at: issued.expiresAt.toISOString(),
      },
    },
    link: {
      uri,
      name,
      ...(mimeType ? { mimeType } : {}),
      ...(asset.descriptor.size !== undefined ? { size: asset.descriptor.size } : {}),
    },
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
      media: asset.descriptor,
      representation: { kind: "metadata" },
      code,
      retryable,
      message: "No supported media representation is available.",
    },
  };
}
