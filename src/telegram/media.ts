import { open, unlink, type FileHandle } from "node:fs/promises";
import { GramScopeError } from "../errors/taxonomy";
import { mediaId, type MediaDescriptor } from "../schemas/media";
import { mediaOf } from "../schemas/message";
import { mediaError } from "../errors/taxonomy";
import { fetchDialogIndex } from "./dialog-index";
import { getApi, type TelegramLike } from "./client";
import { readBigId } from "./peer-id";
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
  const descriptor = mediaOf(rawMedia);
  if (!descriptor) return undefined;
  return {
    ...descriptor,
    media_id: "med_pending",
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
  const asset = normalizeMediaAsset(source, rawMessage, rawMedia);
  const location = await thumbnailLocation(rawMedia);
  return {
    ...asset,
    ...(location !== undefined ? { thumbnailLocation: location } : {}),
  };
}

async function thumbnailLocation(rawMedia: Record<string, unknown>): Promise<unknown | undefined> {
  const photo = record(rawMedia.photo);
  if (photo) {
    const selected = selectThumbnail(photo.sizes, 1280);
    if (!selected) return undefined;
    const Api = await getApi();
    return new Api.InputPhotoFileLocation({
      id: photo.id as never,
      accessHash: photo.accessHash as never,
      fileReference: photo.fileReference as never,
      thumbSize: String(selected.type ?? "y"),
    });
  }
  const document = record(rawMedia.document);
  if (document) {
    const selected = selectThumbnail(document.thumbs, 1280);
    if (!selected) return undefined;
    const Api = await getApi();
    return new Api.InputDocumentFileLocation({
      id: document.id as never,
      accessHash: document.accessHash as never,
      fileReference: document.fileReference as never,
      thumbSize: String(selected.type ?? "y"),
    });
  }
  return undefined;
}

function selectThumbnail(raw: unknown, targetLongEdge: number): Record<string, unknown> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const sizes = raw
    .map(record)
    .filter((size): size is Record<string, unknown> => size !== undefined)
    .filter((size) =>
      !["PhotoStrippedSize", "PhotoCachedSize"].includes(String(size.className)) &&
      typeof size.w === "number" && typeof size.h === "number")
    .sort((a, b) => Math.max(Number(a.w), Number(a.h)) - Math.max(Number(b.w), Number(b.h)));
  return sizes.find((size) => Math.max(Number(size.w), Number(size.h)) >= targetLongEdge)
    ?? sizes.at(-1);
}

export async function readAssetThumbnail(
  client: TelegramLike,
  asset: MediaAsset,
  limit: number,
  signal?: AbortSignal,
): Promise<{ type: "image"; data: Buffer; mimeType: string } | undefined> {
  if (asset.thumbnailLocation === undefined) return undefined;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of iterAssetBytes(client, asset, {
    file: asset.thumbnailLocation,
    limit: limit + 1,
    signal,
  })) {
    total += chunk.length;
    if (total > limit) {
      throw mediaError("INLINE_LIMIT_EXCEEDED", `Media exceeds the ${limit}-byte inline limit`);
    }
    chunks.push(chunk);
  }
  return { type: "image", data: Buffer.concat(chunks, total), mimeType: "image/jpeg" };
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

async function writeWhole(handle: FileHandle, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
    if (bytesWritten <= 0) {
      throw mediaError("TELEGRAM_DOWNLOAD_FAILED", "Telegram media download failed", true);
    }
    offset += bytesWritten;
  }
}

function iteratorCloser(iterator: AsyncIterator<Buffer>): () => void {
  let initiated = false;
  return () => {
    if (initiated) return;
    initiated = true;
    const closing = iterator.return?.();
    if (closing) void closing.catch(() => undefined);
  };
}

async function nextAssetChunk(
  iterator: AsyncIterator<Buffer>,
  signal: AbortSignal,
  close: () => void,
): Promise<IteratorResult<Buffer>> {
  if (signal.aborted) {
    close();
    throw new DOMException("Media download aborted", "AbortError");
  }
  return new Promise<IteratorResult<Buffer>>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      // Teleproto exposes AbortSignal and AsyncIterator.return(), but no API
      // that can synchronously cancel an already-dispatched MTProto invoke.
      // Initiate both immediately; the in-flight RPC may settle afterward.
      close();
      reject(new DOMException("Media download aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    iterator.next().then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

export async function downloadAssetToFile(
  client: TelegramLike,
  asset: MediaAsset,
  options: {
    path: string;
    maxBytes: number;
    deadlineMs: number;
    signal?: AbortSignal;
  },
): Promise<number> {
  const controller = new AbortController();
  const startedAt = Date.now();
  let created = false;
  let completed = false;
  let handle: FileHandle | undefined;
  const abort = () => controller.abort();
  const timer = setTimeout(abort, options.deadlineMs);
  options.signal?.addEventListener("abort", abort, { once: true });

  try {
    if (options.signal?.aborted || controller.signal.aborted) {
      throw mediaError("PROCESSING_TIMEOUT", "Video processing exceeded its deadline", true);
    }
    handle = await open(options.path, "wx", 0o600);
    created = true;
    let total = 0;
    for await (const chunk of iterAssetBytes(client, asset, {
      limit: options.maxBytes + 1,
      signal: controller.signal,
    })) {
      if (
        controller.signal.aborted ||
        options.signal?.aborted ||
        Date.now() - startedAt >= options.deadlineMs
      ) {
        throw mediaError("PROCESSING_TIMEOUT", "Video processing exceeded its deadline", true);
      }
      total += chunk.length;
      if (total > options.maxBytes) {
        throw mediaError(
          "INLINE_LIMIT_EXCEEDED",
          `Media exceeds the ${options.maxBytes}-byte processing limit`,
          false,
        );
      }
      await writeWhole(handle, chunk);
      if (
        controller.signal.aborted ||
        options.signal?.aborted ||
        Date.now() - startedAt >= options.deadlineMs
      ) {
        throw mediaError("PROCESSING_TIMEOUT", "Video processing exceeded its deadline", true);
      }
    }
    if (
      controller.signal.aborted ||
      options.signal?.aborted ||
      Date.now() - startedAt >= options.deadlineMs
    ) {
      throw mediaError("PROCESSING_TIMEOUT", "Video processing exceeded its deadline", true);
    }
    completed = true;
    return total;
  } catch (error) {
    if (error instanceof GramScopeError) throw error;
    if (
      controller.signal.aborted ||
      options.signal?.aborted ||
      (error instanceof DOMException && error.name === "AbortError")
    ) {
      throw mediaError("PROCESSING_TIMEOUT", "Video processing exceeded its deadline", true);
    }
    throw mediaError("TELEGRAM_DOWNLOAD_FAILED", "Telegram media download failed", true);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    await handle?.close().catch(() => undefined);
    if (created && !completed) {
      await unlink(options.path).catch(() => undefined);
    }
  }
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
    ...(options.signal ? { signal: options.signal } : {}),
  })[Symbol.asyncIterator]();
  const close = iteratorCloser(iterator);
  try {
    while (true) {
      const next = options.signal
        ? await nextAssetChunk(iterator, options.signal, close)
        : await iterator.next();
      if (next.done) return;
      const chunk = next.value;
      if (remaining === undefined) {
        yield chunk;
        continue;
      }
      if (remaining <= 0) return;
      const exact = chunk.subarray(0, remaining);
      remaining -= exact.length;
      if (exact.length > 0) yield exact;
    }
  } finally {
    close();
  }
}
