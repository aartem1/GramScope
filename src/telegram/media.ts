import { mediaId, type MediaDescriptor } from "../schemas/media";
import { mediaError } from "../errors/taxonomy";
import { fetchDialogIndex } from "./dialog-index";
import type { TelegramLike } from "./client";
import { resolveSource, type ResolvedSource } from "./peer-resolve";

export type MediaAsset = {
  sourceId: string;
  messageId: number;
  sourceHandle: string;
  descriptor: MediaDescriptor;
  rawMessage: Record<string, unknown>;
  rawMedia: Record<string, unknown>;
  thumbnailLocation?: unknown;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function readBigId(value: unknown): string | undefined {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && value.length > 0) return value;
  return undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function photoSize(photo: Record<string, unknown>): Record<string, unknown> | undefined {
  const sizes = Array.isArray(photo.sizes) ? photo.sizes : [];
  let largest: Record<string, unknown> | undefined;
  let largestBytes = -1;
  for (const candidate of sizes) {
    const size = record(candidate);
    if (!size) continue;
    const bytes = positiveNumber(size.size) ?? 0;
    if (bytes > largestBytes) {
      largest = size;
      largestBytes = bytes;
    }
  }
  return largest;
}

function descriptorOf(rawMedia: Record<string, unknown>): MediaDescriptor | undefined {
  const photo = record(rawMedia.photo);
  if (photo) {
    const size = photoSize(photo);
    return {
      media_id: "med_pending",
      type: "photo",
      mime_type: "image/jpeg",
      ...(positiveNumber(size?.size) !== undefined ? { size: positiveNumber(size?.size) } : {}),
      ...(positiveNumber(size?.w) !== undefined ? { width: positiveNumber(size?.w) } : {}),
      ...(positiveNumber(size?.h) !== undefined ? { height: positiveNumber(size?.h) } : {}),
      ...(Array.isArray(photo.sizes) && photo.sizes.length > 1 ? { has_thumbnail: true } : {}),
    };
  }

  const document = record(rawMedia.document);
  if (!document) return undefined;
  const attributes = Array.isArray(document.attributes) ? document.attributes : [];
  const audio = attributes
    .map(record)
    .find((attribute) => attribute?.className === "DocumentAttributeAudio");
  const fileName = attributes
    .map(record)
    .find((attribute) => attribute?.className === "DocumentAttributeFilename")?.fileName;
  const mimeType = typeof document.mimeType === "string" ? document.mimeType : undefined;
  const isVoice = audio?.voice === true;
  const type = isVoice ? "voice" : mimeType?.startsWith("audio/") ? "audio" : "document";
  return {
    media_id: "med_pending",
    type,
    ...(typeof fileName === "string" ? { file_name: fileName } : {}),
    ...(mimeType ? { mime_type: mimeType } : {}),
    ...(positiveNumber(document.size) !== undefined ? { size: positiveNumber(document.size) } : {}),
    ...(positiveNumber(audio?.duration) !== undefined
      ? { duration_seconds: positiveNumber(audio?.duration) }
      : {}),
    ...(Array.isArray(document.thumbs) && document.thumbs.length > 0 ? { has_thumbnail: true } : {}),
  };
}

function normalizeMediaAsset(
  source: ResolvedSource,
  rawMessage: Record<string, unknown>,
  rawMedia: Record<string, unknown>,
): MediaAsset {
  const messageId = rawMessage.id;
  if (typeof messageId !== "number" || !Number.isInteger(messageId)) {
    throw mediaError("MEDIA_NOT_FOUND", "The Telegram message no longer exists");
  }
  const descriptor = descriptorOf(rawMedia);
  const downloadable = record(rawMedia.document) ?? record(rawMedia.photo);
  const rawId = readBigId(downloadable?.id);
  if (!descriptor || rawId === undefined) {
    throw mediaError("NO_MEDIA", "The message has no downloadable media");
  }
  return {
    sourceId: source.source_id,
    messageId,
    sourceHandle: source.handle,
    descriptor: {
      ...descriptor,
      media_id: mediaId(source.source_id, messageId, descriptor.type, rawId),
    },
    rawMessage,
    rawMedia,
  };
}

export async function resolveMediaAsset(
  client: TelegramLike,
  input: { sourceId: string; messageId: number },
): Promise<MediaAsset> {
  const index = await fetchDialogIndex({ includeFolders: false });
  const source = await resolveSource(client, index, input.sourceId);
  const rows = Array.from(await client.getMessages(source.handle, { ids: [input.messageId] }));
  const rawMessage = record(rows[0]);
  if (!rawMessage || rawMessage.className === "MessageEmpty") {
    throw mediaError("MEDIA_NOT_FOUND", "The Telegram message no longer exists");
  }
  const rawMedia = record(rawMessage.media);
  if (!rawMedia) {
    throw mediaError("NO_MEDIA", "The message has no downloadable media");
  }
  return normalizeMediaAsset(source, rawMessage, rawMedia);
}

export async function readAssetBytes(
  client: TelegramLike,
  asset: MediaAsset,
  limit: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of iterAssetBytes(client, asset, { limit: limit + 1, signal })) {
    total += chunk.length;
    if (total > limit) {
      throw mediaError("INLINE_LIMIT_EXCEEDED", `Media exceeds the ${limit}-byte inline limit`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

export async function* iterAssetBytes(
  client: TelegramLike,
  asset: MediaAsset,
  options: { file?: unknown; offset?: number; limit?: number; signal?: AbortSignal } = {},
): AsyncGenerator<Buffer, void, unknown> {
  let remaining = options.limit;
  const iterator = client.iterDownload(options.file ?? asset.rawMessage, {
    ...(options.offset !== undefined ? { offset: options.offset } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    requestSize: 512 * 1024,
  });
  for await (const chunk of iterator) {
    if (options.signal?.aborted) throw new DOMException("Media download aborted", "AbortError");
    if (remaining === undefined) {
      yield chunk;
      continue;
    }
    if (remaining <= 0) return;
    const exact = chunk.subarray(0, remaining);
    remaining -= exact.length;
    if (exact.length > 0) yield exact;
  }
}
