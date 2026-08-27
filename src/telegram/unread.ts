import {
  fetchDialogIndex,
  folderMembers,
  type DialogIndex,
} from "./dialog-index";
import { fitToSizeCap } from "../schemas/size";

export type UnreadSummaryInput = {
  group_by?: "source" | "folder";
  folder_ids?: string[];
};

export type UnreadGroup = {
  source_id?: string;
  folder_id?: string;
  title: string;
  unread_count: number;
  read_inbox_max_id?: number;
  latest_message_id?: number;
  latest_message_date?: string;
};

export type UnreadSummaryResult = {
  groups: UnreadGroup[];
  total_unread: number;
};

/**
 * Everything here comes off the dialog list the index already holds:
 * unread_count, the read pointer and the top message are all fields Telegram
 * puts on a Dialog. The summary therefore costs zero extra round trips.
 *
 * total_unread counts every group in scope, including any the size cap
 * trimmed off the end of `groups`.
 */
export function summarize(
  index: DialogIndex,
  input: UnreadSummaryInput,
): UnreadSummaryResult {
  const scoped = input.folder_ids?.length
    ? new Set(folderMembers(index.folders, input.folder_ids))
    : undefined;

  if ((input.group_by ?? "source") === "folder") {
    const wanted = input.folder_ids?.length
      ? index.folders.filter((f) => input.folder_ids!.includes(f.id))
      : index.folders;

    const groups: UnreadGroup[] = wanted
      .map((folder) => {
        const excluded = new Set(folder.excluded_peer_ids);
        const unread = folder.included_peer_ids
          .filter((id) => !excluded.has(id))
          .reduce(
            (sum, id) => sum + (index.byId.get(id)?.unread_count ?? 0),
            0,
          );
        return {
          folder_id: folder.id,
          title: folder.title,
          unread_count: unread,
        };
      })
      .filter((group) => group.unread_count > 0)
      .sort((a, b) => b.unread_count - a.unread_count);

    return {
      groups,
      total_unread: groups.reduce((sum, g) => sum + g.unread_count, 0),
    };
  }

  const entries = [...index.byId.values()]
    .filter(
      (entry) =>
        entry.unread_count > 0 && (!scoped || scoped.has(entry.source_id)),
    )
    .sort((a, b) => b.unread_count - a.unread_count);

  const total = entries.reduce((sum, entry) => sum + entry.unread_count, 0);

  const groups: UnreadGroup[] = entries.map((entry) => ({
    source_id: entry.source_id,
    title: entry.title,
    unread_count: entry.unread_count,
    read_inbox_max_id: entry.read_inbox_max_id,
    ...(entry.latest_message_id !== undefined
      ? { latest_message_id: entry.latest_message_id }
      : {}),
    ...(entry.latest_message_date !== undefined
      ? { latest_message_date: entry.latest_message_date }
      : {}),
  }));

  const fit = fitToSizeCap(groups, (kept) => ({
    groups: kept,
    total_unread: total,
  }));

  return { groups: groups.slice(0, fit), total_unread: total };
}

export async function getUnreadSummary(
  input: UnreadSummaryInput,
): Promise<UnreadSummaryResult> {
  return summarize(await fetchDialogIndex(), input);
}
