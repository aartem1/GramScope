import { getApi, withTelegram, type TelegramLike } from "./client";
import { mapDialogFilters } from "./folders";
import { GramScopeError } from "../errors/taxonomy";
import type { TelegramFolder } from "../schemas/folder";

/** Telegram's non-Premium ceiling on chat folders. */
export const MAX_FOLDERS = 10;

/** Telegram's ceiling on peers in one folder, non-Premium. */
export const MAX_FOLDER_SOURCES = 100;

/**
 * Telegram reserves filter id 0 for "All chats" and 1 for the archive, so a
 * new folder starts at 2.
 */
const FIRST_FREE_FILTER_ID = 2;

type RawFilter = Record<string, unknown>;

async function fetchRawFilters(client: TelegramLike): Promise<RawFilter[]> {
  const Api = await getApi();
  const raw = (await client.invoke(new Api.messages.GetDialogFilters())) as
    | { filters?: unknown }
    | undefined;
  const filters = raw?.filters;
  // Array.from, not the value itself: TL list fields arrive as Array
  // subclasses whose filter/map/slice preserve the subclass.
  return Array.isArray(filters)
    ? Array.from(filters, (f) => (f ?? {}) as RawFilter)
    : [];
}

/**
 * Locates ONE filter as Telegram returned it. The returned object is the one
 * that goes back on the wire: nothing here maps it into a TelegramFolder,
 * because TelegramFolder models four of a DialogFilter's fifteen fields and
 * the other eleven — emoticon, color, pinnedPeers and eight behaviour flags —
 * exist only inside this object.
 */
function locate(filters: RawFilter[], folderId: string): RawFilter {
  const found = filters.find(
    (f) => f.id !== undefined && String(f.id) === folderId,
  );
  if (!found) {
    throw new GramScopeError(
      "INVALID_INPUT",
      `No folder with id ${folderId}. Call list_folders for valid ids.`,
    );
  }
  if (found.className === "DialogFilterChatlist") {
    throw new GramScopeError(
      "INVALID_INPUT",
      `Folder ${folderId} is a shareable folder (DialogFilterChatlist), which this server does not edit. Writing it back as an ordinary folder would convert it and lose its shared link.`,
    );
  }
  return found;
}

/**
 * Replaces a filter's title, preserving the shape Telegram used. Entities are
 * dropped rather than carried: they index into the OLD text, so keeping them
 * across a rename produces ranges that do not match the string they annotate.
 */
async function setTitle(filter: RawFilter, title: string): Promise<void> {
  if (typeof filter.title === "string") {
    filter.title = title;
    return;
  }
  const Api = await getApi();
  filter.title = new Api.TextWithEntities({ text: title, entities: [] });
}

function titleOf(filter: RawFilter): string {
  const title = filter.title;
  if (typeof title === "string") return title;
  if (typeof title === "object" && title !== null && "text" in title) {
    const text = (title as { text: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
}

/**
 * Sends one filter back and returns the folder list as Telegram then holds it.
 * The re-read is deliberate: `order` is a position in the server's list, not a
 * property of the filter, so it cannot be computed from what was sent.
 */
async function writeFilter(
  client: TelegramLike,
  id: number,
  filter?: RawFilter,
): Promise<TelegramFolder[]> {
  const Api = await getApi();
  await client.invoke(
    new Api.messages.UpdateDialogFilter({
      id,
      ...(filter !== undefined ? { filter: filter as never } : {}),
    }),
  );
  return mapDialogFilters({ filters: await fetchRawFilters(client) });
}

function folderById(
  folders: TelegramFolder[],
  folderId: string,
): TelegramFolder {
  const folder = folders.find((f) => f.id === folderId);
  if (!folder) {
    throw new GramScopeError(
      "INTERNAL_ERROR",
      `Telegram accepted the change to folder ${folderId} but does not report the folder`,
    );
  }
  return folder;
}

export async function createFolder(input: {
  title: string;
  source_ids?: string[];
}): Promise<TelegramFolder> {
  return withTelegram(async (client) => {
    const filters = await fetchRawFilters(client);
    const existing = filters.filter((f) => typeof f.id === "number");
    if (existing.length >= MAX_FOLDERS) {
      throw new GramScopeError(
        "INVALID_INPUT",
        `The account already holds ${existing.length} folders and Telegram allows at most ${MAX_FOLDERS}. Delete one first.`,
      );
    }

    const taken = new Set(existing.map((f) => Number(f.id)));
    let id = FIRST_FREE_FILTER_ID;
    while (taken.has(id)) id++;

    const Api = await getApi();
    const filter: RawFilter = new Api.DialogFilter({
      id,
      title: new Api.TextWithEntities({ text: input.title, entities: [] }),
      pinnedPeers: [],
      includePeers: [],
      excludePeers: [],
    }) as unknown as RawFilter;

    // `input.source_ids` is accepted but not yet honoured: filling a new
    // folder needs resolveIncludePeers, which Task 9 adds. Task 9 adds the
    // branch here too. Do NOT reference resolveIncludePeers in this task — it
    // does not exist yet and this task must compile on its own.

    return folderById(await writeFilter(client, id, filter), String(id));
  });
}

export async function renameFolder(input: {
  folder_id: string;
  title: string;
}): Promise<TelegramFolder> {
  return withTelegram(async (client) => {
    const filter = locate(await fetchRawFilters(client), input.folder_id);
    await setTitle(filter, input.title);
    return folderById(
      await writeFilter(client, Number(filter.id), filter),
      input.folder_id,
    );
  });
}

export async function deleteFolder(input: {
  folder_id: string;
}): Promise<{ deleted_folder_id: string; title: string }> {
  return withTelegram(async (client) => {
    const filter = locate(await fetchRawFilters(client), input.folder_id);
    const title = titleOf(filter);
    // No filter argument: that is how UpdateDialogFilter deletes.
    await writeFilter(client, Number(filter.id));
    return { deleted_folder_id: input.folder_id, title };
  });
}
