import {
  getApi,
  resolveEntity,
  withTelegram,
  type TelegramLike,
} from "./client";
import { fetchFolders } from "./folders";
import {
  entityMarkedId,
  entityUsername,
  markedChannelId,
  readBigId,
  sourceType,
} from "../peer-id";
import type { TelegramFolder } from "../schemas/folder";
import type { TelegramSource } from "../schemas/source";
import { decodeCursor, encodeCursor } from "../pagination";
import { GramScopeError } from "../errors/taxonomy";
import { fitToSizeCap } from "../schemas/size";

export type ListDialogsInput = {
  folder_id?: string;
  unread_only?: boolean;
  type?: "channel" | "group" | "chat";
  limit: number;
  cursor?: string;
};

export function foldersByPeer(
  folders: TelegramFolder[],
): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const folder of folders) {
    const excluded = new Set(folder.excluded_peer_ids);
    for (const id of folder.included_peer_ids) {
      if (excluded.has(id)) continue;
      const existing = index.get(id);
      if (existing) existing.push(folder.id);
      else index.set(id, [folder.id]);
    }
  }
  return index;
}

/**
 * Facts a caller knows that the entity itself does not carry: a dialog's
 * unread state, or the extra fields only `channels.getFullChannel` returns.
 */
export type SourceDetails = {
  /** Marked id, when the caller has an authoritative one (a Dialog does). */
  id?: string;
  /** Display name, when the caller has a better one than `entity.title`. */
  title?: string;
  unreadCount?: number;
  readInboxMaxId?: number;
  /**
   * Telegram's manual "come back to this" flag (`Dialog.unreadMark`), which is
   * independent of unreadCount: a source can carry the flag with zero unread
   * messages, which is exactly what mark_unread produces.
   */
  unreadMark?: boolean;
  description?: string;
  linkedDiscussionId?: string;
};

/**
 * The single `TelegramSource` constructor. Both `list_dialogs` and
 * `get_channel` build their result here so the two can never again disagree
 * about a peer's id, type, or which fields it carries.
 */
export function toSource(
  entity: unknown,
  folderIdsByPeer: Map<string, string[]>,
  details: SourceDetails = {},
): TelegramSource {
  const e = (entity ?? {}) as Record<string, unknown>;

  const id = details.id ?? entityMarkedId(e) ?? "";
  const username = entityUsername(e);
  const description =
    details.description ?? (typeof e.about === "string" ? e.about : undefined);
  const title =
    details.title ??
    (typeof e.title === "string"
      ? e.title
      : typeof e.firstName === "string"
        ? e.firstName
        : "");
  const folderIds = folderIdsByPeer.get(id);

  return {
    id,
    title,
    type: sourceType(e),
    ...(username ? { username, url: `https://t.me/${username}` } : {}),
    ...(description ? { description } : {}),
    ...(typeof e.participantsCount === "number"
      ? { subscriber_count: e.participantsCount }
      : {}),
    ...(typeof details.unreadCount === "number"
      ? { unread_count: details.unreadCount }
      : {}),
    ...(typeof details.readInboxMaxId === "number"
      ? { read_inbox_max_id: details.readInboxMaxId }
      : {}),
    ...(details.unreadMark === true ? { unread_mark: true } : {}),
    ...(details.linkedDiscussionId
      ? { linked_discussion_id: details.linkedDiscussionId }
      : {}),
    ...(folderIds ? { folder_ids: folderIds } : {}),
  };
}

export function mapDialog(
  dialog: unknown,
  folderIdsByPeer: Map<string, string[]>,
): TelegramSource {
  const d = (dialog ?? {}) as Record<string, unknown>;
  const entity = (d.entity ?? {}) as Record<string, unknown>;
  const inner = (d.dialog ?? {}) as Record<string, unknown>;

  // Dialog.id is teleproto's own marked id, so it wins over re-deriving one
  // from the entity; the derivation is the fallback, not the rule.
  const id = readBigId(d.id);

  return toSource(entity, folderIdsByPeer, {
    ...(id !== undefined ? { id } : {}),
    ...(typeof d.title === "string" ? { title: d.title } : {}),
    ...(typeof d.unreadCount === "number"
      ? { unreadCount: d.unreadCount }
      : {}),
    ...(typeof inner.readInboxMaxId === "number"
      ? { readInboxMaxId: inner.readInboxMaxId }
      : {}),
    ...(inner.unreadMark === true ? { unreadMark: true } : {}),
  });
}

export async function listDialogs(
  input: ListDialogsInput,
): Promise<{ sources: TelegramSource[]; next_cursor?: string }> {
  const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
  const folders = await fetchFolders();
  const folderIndex = foldersByPeer(folders);

  let allowed: Set<string> | undefined;
  if (input.folder_id) {
    const folder = folders.find((f) => f.id === input.folder_id);
    if (!folder) {
      throw new GramScopeError(
        "INVALID_INPUT",
        `No folder with id ${input.folder_id}. Call list_folders for valid ids.`,
      );
    }
    const excluded = new Set(folder.excluded_peer_ids);
    allowed = new Set(
      folder.included_peer_ids.filter((id) => !excluded.has(id)),
    );
  }

  const batchSize = input.limit + 1;
  const raw = await withTelegram(async (client) =>
    client.getDialogs({
      // Ask for extra rows to cover the boundary dialogs we already served and
      // are about to drop. Without this a page whose whole window is made of
      // repeats comes back empty and pagination stalls before the end.
      limit: batchSize + (cursor?.boundaryIds.length ?? 0),
      // Telegram returns pinned dialogs regardless of the offset, so a
      // continuation page must exclude them or a pinned dialog whose top
      // message predates the offset is served twice. teleproto sets
      // excludePinned on its own continuation chunks for exactly this reason;
      // our resume is stateless, so we set it per request instead.
      ignorePinned: cursor !== undefined,
      // Only date and id: teleproto forwards offsetPeer straight into
      // Api.messages.GetDialogs without resolving it, so it must be a real
      // InputPeer object, which a stateless server cannot rebuild. See the
      // note on DialogCursor.
      ...(cursor
        ? { offsetDate: cursor.offsetDate, offsetId: cursor.offsetId }
        : {}),
    }),
  );

  // Filters below are client-side, so a row must keep its link to the raw
  // dialog it came from: the cursor is derived from how far we consumed the
  // RAW batch, never from the filtered page's length.
  type Row = { raw: Record<string, unknown>; source: TelegramSource };
  // Array.from, not raw.map: teleproto returns a TotalList (an Array subclass
  // carrying `total`), and map/filter/slice preserve the subclass through
  // Symbol.species, so a plain `.map` here would carry the stray property
  // through `rows`, `kept`, `page` and out into the returned `sources`.
  let rows: Row[] = Array.from(raw, (dialog) => ({
    raw: (dialog ?? {}) as Record<string, unknown>,
    source: mapDialog(dialog, folderIndex),
  }));

  // Telegram's offset_date is inclusive, so the dialogs that sat exactly on
  // the previous page's boundary come back. Drop the ones already served.
  // This happens before any filtering, so re-served rows do not consume the
  // page budget.
  if (cursor && cursor.boundaryIds.length > 0) {
    const alreadySeen = new Set(cursor.boundaryIds);
    rows = rows.filter(
      (r) =>
        !(r.raw.date === cursor.offsetDate && alreadySeen.has(r.source.id)),
    );
  }

  let kept = rows;
  if (allowed) kept = kept.filter((r) => allowed.has(r.source.id));
  if (input.unread_only) {
    kept = kept.filter((r) => (r.source.unread_count ?? 0) > 0);
  }
  if (input.type) kept = kept.filter((r) => r.source.type === input.type);

  const limited = kept.slice(0, input.limit);
  const fit = fitToSizeCap(
    limited.map((r) => r.source),
    (items) => ({ sources: items }),
  );
  const page = limited.slice(0, fit);
  const sources = page.map((r) => r.source);

  // Truncated inside the batch: resume after the last row we actually
  // returned. Otherwise we consumed the whole batch: resume after its end.
  const truncated = page.length < kept.length;
  const lastExamined = truncated ? page[page.length - 1] : rows[rows.length - 1];
  const hasMore = truncated || raw.length >= batchSize;

  if (!hasMore || !lastExamined) return { sources };

  const last = lastExamined.raw;
  const message = last.message as Record<string, unknown> | undefined;
  const boundaryDate = typeof last.date === "number" ? last.date : 0;
  return {
    sources,
    next_cursor: encodeCursor({
      offsetDate: boundaryDate,
      offsetId: typeof message?.id === "number" ? message.id : 0,
      // Every row served on the boundary timestamp, so the next page can drop
      // them when Telegram returns them again. These accumulate while the
      // boundary date holds and reset once it moves on, so the list stays
      // bounded by however many dialogs share a single second.
      boundaryIds: [
        ...new Set([
          ...(cursor && cursor.offsetDate === boundaryDate
            ? cursor.boundaryIds
            : []),
          ...page
            .filter((r) => r.raw.date === boundaryDate)
            .map((r) => r.source.id),
        ]),
      ],
    }),
  };
}

/**
 * `channels.getFullChannel` is the only source of `about` and the linked
 * discussion chat: the `Api.Channel` that `getEntity` returns carries neither.
 */
export async function fetchChannelDetails(
  client: TelegramLike,
  entity: unknown,
): Promise<SourceDetails> {
  const Api = await getApi();
  const raw = await client.invoke(
    new Api.channels.GetFullChannel({ channel: entity as never }),
  );

  const fullChat =
    typeof raw === "object" && raw !== null
      ? ((raw as { fullChat?: unknown }).fullChat as
          | Record<string, unknown>
          | undefined)
      : undefined;
  if (!fullChat) return {};

  const about = typeof fullChat.about === "string" ? fullChat.about : undefined;
  const linked = readBigId(fullChat.linkedChatId);

  return {
    ...(about ? { description: about } : {}),
    // linkedChatId is bare, and a linked discussion chat is always a
    // megagroup, so it marks as a channel.
    ...(linked !== undefined
      ? { linkedDiscussionId: markedChannelId(linked) }
      : {}),
  };
}

export async function getChannel(input: {
  id?: string;
  username?: string;
  url?: string;
}): Promise<TelegramSource> {
  const identifiers = [input.id, input.username, input.url].filter(Boolean);
  if (identifiers.length !== 1) {
    throw new GramScopeError(
      "INVALID_INPUT",
      "Provide exactly one of id, username, or url",
    );
  }

  let target = input.id ?? input.username ?? "";
  if (input.url) {
    const match = /t\.me\/(?:s\/)?([A-Za-z0-9_]+)/.exec(input.url);
    if (!match) {
      throw new GramScopeError("INVALID_INPUT", "Unrecognized Telegram URL");
    }
    target = match[1]!;
  }

  const folders = await fetchFolders();
  const index = foldersByPeer(folders);

  return withTelegram(async (client) => {
    const entity = await resolveEntity(client, target);

    // Broadcast channels and megagroups have more to say than the entity
    // carries. A failure here costs those extra fields, never the call: the
    // basic entity is still a valid answer.
    const details: SourceDetails =
      entity.className === "Channel"
        ? await fetchChannelDetails(client, entity).catch(() => ({}))
        : {};

    return toSource(entity, index, details);
  });
}
