import { getApi, withTelegram } from "./client";
import { inputPeerMarkedId } from "./peer-id";
import type { TelegramFolder } from "../schemas/folder";

/**
 * Normalizes any InputPeer variant to the MARKED id string, which is the form
 * `TelegramSource.id` uses. Returning the bare `channelId` here is what made
 * `folder_ids` and `list_dialogs(folder_id=…)` silently empty for every
 * channel and group.
 */
export function peerId(peer: unknown): string | undefined {
  return inputPeerMarkedId(peer);
}

function titleText(title: unknown): string {
  if (typeof title === "string") return title;
  if (typeof title === "object" && title !== null && "text" in title) {
    const text = (title as { text: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
}

export function mapDialogFilters(raw: unknown): TelegramFolder[] {
  const filters =
    typeof raw === "object" && raw !== null && "filters" in raw
      ? (raw as { filters: unknown }).filters
      : undefined;
  if (!Array.isArray(filters)) return [];

  const folders: TelegramFolder[] = [];
  for (const filter of filters) {
    if (typeof filter !== "object" || filter === null) continue;
    const f = filter as Record<string, unknown>;

    // DialogFilterDefault is the "All chats" pseudo-entry: no id, no title.
    if (f.id === undefined || f.title === undefined) continue;

    const include = Array.isArray(f.includePeers) ? f.includePeers : [];
    const exclude = Array.isArray(f.excludePeers) ? f.excludePeers : [];

    folders.push({
      id: String(f.id),
      title: titleText(f.title),
      included_peer_ids: include
        .map(peerId)
        .filter((id): id is string => id !== undefined),
      excluded_peer_ids: exclude
        .map(peerId)
        .filter((id): id is string => id !== undefined),
      order: folders.length,
    });
  }
  return folders;
}

export async function fetchFolders(): Promise<TelegramFolder[]> {
  return withTelegram(async (client) => {
    const Api = await getApi();
    const raw = await client.invoke(new Api.messages.GetDialogFilters());
    return mapDialogFilters(raw);
  });
}
