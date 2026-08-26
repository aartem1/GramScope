import { withTelegram } from "./client";
import type { TelegramFolder } from "../schemas/folder";

function readBigId(value: unknown): string | undefined {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "value" in value) {
    return readBigId((value as { value: unknown }).value);
  }
  return undefined;
}

/** Normalizes any InputPeer variant to a decimal id string. */
export function peerId(peer: unknown): string | undefined {
  if (typeof peer !== "object" || peer === null) return undefined;
  const p = peer as Record<string, unknown>;
  return (
    readBigId(p.channelId) ?? readBigId(p.chatId) ?? readBigId(p.userId)
  );
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
    const { Api } = await import("teleproto");
    const raw = await client.invoke(new Api.messages.GetDialogFilters());
    return mapDialogFilters(raw);
  });
}
