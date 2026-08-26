import { withTelegram } from "./client";
import { fetchFolders } from "./folders";
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

function readBigId(value: unknown): string | undefined {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "value" in value) {
    return readBigId((value as { value: unknown }).value);
  }
  return undefined;
}

export function dialogType(dialog: unknown): "channel" | "group" | "chat" {
  const d = dialog as Record<string, unknown>;
  if (d.isChannel === true && d.isGroup !== true) return "channel";
  if (d.isGroup === true) return "group";
  return "chat";
}

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

export function mapDialog(
  dialog: unknown,
  folderIdsByPeer: Map<string, string[]>,
): TelegramSource {
  const d = dialog as Record<string, unknown>;
  const entity = (d.entity ?? {}) as Record<string, unknown>;
  const inner = (d.dialog ?? {}) as Record<string, unknown>;

  const id = readBigId(d.id) ?? "";
  const username =
    typeof entity.username === "string" ? entity.username : undefined;
  const folderIds = folderIdsByPeer.get(id);

  return {
    id,
    title: typeof d.title === "string" ? d.title : "",
    type: dialogType(dialog),
    ...(username ? { username, url: `https://t.me/${username}` } : {}),
    ...(typeof entity.about === "string" ? { description: entity.about } : {}),
    ...(typeof entity.participantsCount === "number"
      ? { subscriber_count: entity.participantsCount }
      : {}),
    ...(typeof d.unreadCount === "number"
      ? { unread_count: d.unreadCount }
      : {}),
    ...(typeof inner.readInboxMaxId === "number"
      ? { read_inbox_max_id: inner.readInboxMaxId }
      : {}),
    ...(folderIds ? { folder_ids: folderIds } : {}),
  };
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
      limit: batchSize,
      ...(cursor
        ? { offsetDate: cursor.offsetDate, offsetId: cursor.offsetId }
        : {}),
    }),
  );

  // Filters below are client-side, so a row must keep its link to the raw
  // dialog it came from: the cursor is derived from how far we consumed the
  // RAW batch, never from the filtered page's length.
  type Row = { raw: Record<string, unknown>; source: TelegramSource };
  const rows: Row[] = raw.map((dialog) => ({
    raw: (dialog ?? {}) as Record<string, unknown>,
    source: mapDialog(dialog, folderIndex),
  }));

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
  return {
    sources,
    next_cursor: encodeCursor({
      offsetDate: typeof last.date === "number" ? last.date : 0,
      offsetId: typeof message?.id === "number" ? message.id : 0,
      offsetPeerId: readBigId(last.id) ?? "",
    }),
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
    const entity = await client.getEntity(target);
    const id = readBigId(entity.id) ?? "";
    const username =
      typeof entity.username === "string" ? entity.username : undefined;
    const folderIds = index.get(id);

    return {
      id,
      title:
        typeof entity.title === "string"
          ? entity.title
          : typeof entity.firstName === "string"
            ? entity.firstName
            : "",
      type:
        entity.className === "Channel" && entity.megagroup !== true
          ? "channel"
          : entity.className === "Channel" || entity.className === "Chat"
            ? "group"
            : "chat",
      ...(username ? { username, url: `https://t.me/${username}` } : {}),
      ...(typeof entity.participantsCount === "number"
        ? { subscriber_count: entity.participantsCount }
        : {}),
      ...(folderIds ? { folder_ids: folderIds } : {}),
    };
  });
}
