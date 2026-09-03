import { getApi, type TelegramLike } from "./client";
import type { MediaType } from "../limits";
import { mapMessage, type TelegramMessage } from "../schemas/message";

export { MEDIA_TYPES, type MediaType } from "../limits";

export type SliceRequest = {
  sourceId: string;
  /** What to pass to teleproto when it differs from the marked id. */
  handle?: string;
  username?: string;
  readInboxMaxId?: number;
  limit: number;
  /** 0 means "start from the newest message". */
  offsetId: number;
  /** Inclusive lower bound on message date, unix seconds. */
  fromSeconds?: number;
  /** Inclusive upper bound on message date, unix seconds. */
  toSeconds?: number;
  unreadOnly?: boolean;
  mediaType?: MediaType;
};

export type Slice = {
  messages: TelegramMessage[];
  hasMore: boolean;
  /** Resume point for the next page; 0 when the source is exhausted. */
  nextOffsetId: number;
};

/**
 * messages.getHistory cannot filter by media type, so a typed request has to
 * go through messages.search with an empty query — the same primitive the
 * Telegram app uses for its media tabs. teleproto's getMessages picks Search
 * over GetHistory precisely when a filter is present, so passing one here is
 * the whole switch.
 */
export async function mediaFilter(type: MediaType | undefined): Promise<unknown> {
  if (type === undefined) return undefined;
  const Api = await getApi();
  switch (type) {
    case "photo":
      return new Api.InputMessagesFilterPhotos();
    case "video":
      return new Api.InputMessagesFilterVideo();
    case "document":
      return new Api.InputMessagesFilterDocument();
    case "audio":
      return new Api.InputMessagesFilterMusic();
    case "voice":
      return new Api.InputMessagesFilterVoice();
    case "url":
      return new Api.InputMessagesFilterUrl();
    case "gif":
      return new Api.InputMessagesFilterGif();
  }
}

const SKIPPED_CLASSES = new Set(["MessageService", "MessageEmpty"]);

export async function fetchSlice(
  client: TelegramLike,
  request: SliceRequest,
): Promise<Slice> {
  const filter = await mediaFilter(request.mediaType);

  const raw = await client.getMessages(request.handle ?? request.sourceId, {
    limit: request.limit,
    ...(request.offsetId > 0 ? { offsetId: request.offsetId } : {}),
    // Only on a first page: once a cursor exists, offsetId is the exact
    // resume point and a date offset would fight it.
    ...(request.offsetId === 0 && request.toSeconds !== undefined
      ? { offsetDate: request.toSeconds + 1 }
      : {}),
    ...(filter !== undefined ? { filter } : {}),
  });

  const messages: TelegramMessage[] = [];
  // A short batch means Telegram had nothing more to give.
  let exhausted = raw.length < request.limit;
  let lastId = request.offsetId;

  for (const item of raw) {
    const m = (item ?? {}) as Record<string, unknown>;
    const id = typeof m.id === "number" ? m.id : 0;
    const date = typeof m.date === "number" ? m.date : 0;
    lastId = id;

    const name = typeof m.className === "string" ? m.className : "";
    if (SKIPPED_CLASSES.has(name)) continue;

    // Upper bound: a defensive drop. Telegram's own offset already skipped
    // most of these, but its inclusivity is not worth depending on.
    if (request.toSeconds !== undefined && date > request.toSeconds) continue;

    // History is newest-first, so both of the following are stop conditions,
    // not filters: everything after them is older still.
    if (request.fromSeconds !== undefined && date < request.fromSeconds) {
      exhausted = true;
      break;
    }
    if (
      request.unreadOnly === true &&
      request.readInboxMaxId !== undefined &&
      id <= request.readInboxMaxId
    ) {
      exhausted = true;
      break;
    }

    messages.push(
      mapMessage(item, {
        chatId: request.sourceId,
        ...(request.username !== undefined
          ? { username: request.username }
          : {}),
        ...(request.readInboxMaxId !== undefined
          ? { readInboxMaxId: request.readInboxMaxId }
          : {}),
      }),
    );
  }

  return {
    messages,
    hasMore: !exhausted,
    nextOffsetId: exhausted ? 0 : lastId,
  };
}
