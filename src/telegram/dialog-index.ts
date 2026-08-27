import { withTelegram } from "./client";
import { foldersByPeer, mapDialog } from "./dialogs";
import { fetchFolders } from "./folders";
import { isoFromUnix } from "../schemas/message";
import { GramScopeError } from "../errors/taxonomy";
import type { TelegramFolder } from "../schemas/folder";

/**
 * Bounds the worst case of a single bulk scan to avoid an unbounded crawl of
 * the account. teleproto pages getDialogs internally, so a larger limit costs
 * more round trips, not more code. Accounts holding more dialogs than this lose
 * the tail of their dialog list from the index, which shows up as missing
 * titles and skipped unread counts rather than an error.
 */
const DIALOG_SCAN_LIMIT = 1000;

export type DialogEntry = {
  source_id: string;
  title: string;
  username?: string;
  unread_count: number;
  read_inbox_max_id: number;
  latest_message_id?: number;
  latest_message_date?: string;
  folder_ids: string[];
};

export type DialogIndex = {
  byId: Map<string, DialogEntry>;
  folders: TelegramFolder[];
};

export function toEntry(
  dialog: unknown,
  folderIndex: Map<string, string[]>,
): DialogEntry {
  const d = (dialog ?? {}) as Record<string, unknown>;
  const source = mapDialog(dialog, folderIndex);
  const message = (d.message ?? {}) as Record<string, unknown>;
  const latestDate = isoFromUnix(message.date);

  return {
    source_id: source.id,
    title: source.title,
    ...(source.username !== undefined ? { username: source.username } : {}),
    unread_count: source.unread_count ?? 0,
    read_inbox_max_id: source.read_inbox_max_id ?? 0,
    ...(typeof message.id === "number"
      ? { latest_message_id: message.id }
      : {}),
    ...(latestDate !== undefined ? { latest_message_date: latestDate } : {}),
    folder_ids: source.folder_ids ?? [],
  };
}

/**
 * A folder's members are its included peers minus its excluded ones. Its
 * exclude-muted / exclude-read / chat-type flags are ignored here for the same
 * reason list_dialogs ignores them: they depend on live state and would make
 * the same call return different sources on two consecutive runs.
 */
export function folderMembers(
  folders: TelegramFolder[],
  folderIds: string[],
): string[] {
  const members: string[] = [];
  for (const id of folderIds) {
    const folder = folders.find((f) => f.id === id);
    if (!folder) {
      throw new GramScopeError(
        "INVALID_INPUT",
        `No folder with id ${id}. Call list_folders for valid ids.`,
      );
    }
    const excluded = new Set(folder.excluded_peer_ids);
    for (const peer of folder.included_peer_ids) {
      if (!excluded.has(peer)) members.push(peer);
    }
  }
  return members;
}

export async function fetchDialogIndex(
  options: { includeFolders?: boolean } = {},
): Promise<DialogIndex> {
  const folders = options.includeFolders === false ? [] : await fetchFolders();
  const folderIndex = foldersByPeer(folders);
  const raw = await withTelegram(async (client) =>
    client.getDialogs({ limit: DIALOG_SCAN_LIMIT }),
  );

  const byId = new Map<string, DialogEntry>();
  for (const dialog of raw) {
    const entry = toEntry(dialog, folderIndex);
    if (entry.source_id) byId.set(entry.source_id, entry);
  }
  return { byId, folders };
}
