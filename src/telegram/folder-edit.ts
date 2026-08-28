import {
  getApi,
  resolveEntity,
  toInputPeer,
  withTelegram,
  type TelegramLike,
} from "./client";
import { mapDialogFilters, peerId } from "./folders";
import { parseTelegramName } from "./peer-resolve";
import {
  assertSourceIdsBounded,
  MAX_SOURCES_PER_CALL,
} from "./source-selection";
import { GramScopeError } from "../errors/taxonomy";
import type { TelegramFolder } from "../schemas/folder";

/** Telegram's non-Premium ceiling on chat folders. */
export const MAX_FOLDERS = 10;

/** Telegram's ceiling on peers in one folder, non-Premium. */
export const MAX_FOLDER_SOURCES = 100;

/**
 * Telegram's ceiling on a folder title, measured live on 2026-08-29 by
 * bisection against `messages.updateDialogFilter`: 12 characters is accepted,
 * 13 fails with MESSAGE_TOO_LONG. It appears in no TL schema and teleproto
 * does not model it, so it is checked here rather than discovered on the wire
 * — MESSAGE_TOO_LONG alone tells a caller nothing about which limit it hit.
 *
 * Counted in UTF-16 code units, which is what the measurement used. An emoji
 * title is therefore charged more than Telegram may charge it; the belt-and-
 * braces MESSAGE_TOO_LONG mapping in errors/from-telegram.ts keeps the other
 * direction actionable if the real rule ever turns out to be bytes or
 * codepoints.
 */
export const MAX_FOLDER_TITLE = 12;

/**
 * Telegram reserves filter id 0 for "All chats" and 1 for the archive, so a
 * new folder starts at 2.
 */
const FIRST_FREE_FILTER_ID = 2;

type RawFilter = Record<string, unknown>;

function assertFolderTitle(title: string): void {
  if (title.length > MAX_FOLDER_TITLE) {
    throw new GramScopeError(
      "INVALID_INPUT",
      `A folder title may be at most ${MAX_FOLDER_TITLE} characters; this one is ${title.length}. Telegram rejects a longer title. Shorten it.`,
    );
  }
}

/**
 * The source list a new folder starts with. Telegram refuses a filter whose
 * include list is empty (FILTER_INCLUDE_EMPTY, measured live 2026-08-29),
 * exactly as the official app refuses to save an empty folder, so
 * "create the lane, then file sources into it" is not a sequence this tool
 * can offer: the first call would fail with a wire code naming nothing.
 */
function assertCreateSources(sourceIds: string[] | undefined): string[] {
  if (sourceIds === undefined || sourceIds.length === 0) {
    throw new GramScopeError(
      "INVALID_INPUT",
      "manage_folder(create) requires source_ids: a new folder must name at least one source, because Telegram rejects a folder with an empty include list. Create the folder with its first sources, then widen it with add_sources.",
    );
  }
  assertSourceIdsBounded(
    sourceIds,
    "manage_folder(create)",
    MAX_SOURCES_PER_CALL,
  );
  return sourceIds;
}

/**
 * The marked id a `remove_sources` entry names, or an error.
 *
 * A folder stores its members as `InputPeer`s, and this action matches against
 * the marked ids those carry without resolving anything — which is what lets a
 * folder be trimmed with no round trip, and what makes a @username or a t.me
 * link unmatchable here even though `add_sources` accepts both. Silently
 * removing nothing and reporting success is the failure this rejects.
 */
function markedIdToDrop(raw: string): string {
  let markedId: string | undefined;
  try {
    const link = parseTelegramName(raw);
    if (link.kind === "internal") markedId = link.markedId;
  } catch {
    markedId = undefined;
  }
  if (markedId === undefined) {
    throw new GramScopeError(
      "INVALID_INPUT",
      `manage_folder(remove_sources) takes the marked ids a folder holds; "${raw}" is not one. This action resolves no names, so a @username or t.me link would match nothing and remove nothing. Call list_folders and pass entries of the folder's included_peer_ids.`,
    );
  }
  return markedId;
}

async function fetchRawFilters(client: TelegramLike): Promise<RawFilter[]> {
  const Api = await getApi();
  const raw = (await client.invoke(new Api.messages.GetDialogFilters())) as
    { filters?: unknown } | undefined;
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

/**
 * Resolves names into InputPeers, serially and strictly.
 *
 * UpdateDialogFilter replaces the whole filter, so a partial add or create
 * would report success for a call that did less than it was asked.
 */
async function resolveIncludePeers(
  client: TelegramLike,
  sourceIds: string[],
): Promise<unknown[]> {
  const peers: unknown[] = [];
  for (const sourceId of sourceIds) {
    const entity = await resolveEntity(client, sourceId);
    peers.push(await toInputPeer(entity));
  }
  return peers;
}

/**
 * `source_ids` is optional in the type and required at run time: the tool layer
 * hands over whatever the caller sent, and an absent list has to reach a check
 * that can name the constraint rather than a type error nobody sees.
 */
export async function createFolder(input: {
  title: string;
  source_ids?: string[];
}): Promise<TelegramFolder> {
  assertFolderTitle(input.title);
  const sourceIds = assertCreateSources(input.source_ids);

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

    filter.includePeers = await resolveIncludePeers(client, sourceIds);

    return folderById(await writeFilter(client, id, filter), String(id));
  });
}

export async function renameFolder(input: {
  folder_id: string;
  title: string;
}): Promise<TelegramFolder> {
  assertFolderTitle(input.title);

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

export async function addFolderSources(input: {
  folder_id: string;
  source_ids: string[];
}): Promise<TelegramFolder> {
  assertSourceIdsBounded(
    input.source_ids,
    "manage_folder(add_sources)",
    MAX_SOURCES_PER_CALL,
  );

  return withTelegram(async (client) => {
    const filter = locate(await fetchRawFilters(client), input.folder_id);
    const include = Array.isArray(filter.includePeers)
      ? Array.from(filter.includePeers)
      : [];
    const held = new Set(
      include.map(peerId).filter((id): id is string => id !== undefined),
    );
    const resolved = await resolveIncludePeers(client, input.source_ids);
    const added = resolved.filter((peer) => {
      const id = peerId(peer);
      if (id === undefined || held.has(id)) return false;
      held.add(id);
      return true;
    });

    if (include.length + added.length > MAX_FOLDER_SOURCES) {
      throw new GramScopeError(
        "INVALID_INPUT",
        `Folder ${input.folder_id} would hold ${include.length + added.length} sources and Telegram allows at most ${MAX_FOLDER_SOURCES}.`,
      );
    }

    filter.includePeers = [...include, ...added];
    return folderById(
      await writeFilter(client, Number(filter.id), filter),
      input.folder_id,
    );
  });
}

export async function removeFolderSources(input: {
  folder_id: string;
  source_ids: string[];
}): Promise<TelegramFolder> {
  assertSourceIdsBounded(
    input.source_ids,
    "manage_folder(remove_sources)",
    MAX_SOURCES_PER_CALL,
  );
  const drop = new Set(input.source_ids.map(markedIdToDrop));

  return withTelegram(async (client) => {
    const filter = locate(await fetchRawFilters(client), input.folder_id);
    const include = Array.isArray(filter.includePeers)
      ? Array.from(filter.includePeers)
      : [];

    filter.includePeers = include.filter((peer) => {
      const id = peerId(peer);
      return id === undefined || !drop.has(id);
    });

    return folderById(
      await writeFilter(client, Number(filter.id), filter),
      input.folder_id,
    );
  });
}

export async function reorderFolders(input: {
  folder_ids: string[];
}): Promise<TelegramFolder[]> {
  return withTelegram(async (client) => {
    const filters = await fetchRawFilters(client);
    const present = filters
      .filter((filter) => filter.id !== undefined)
      .map((filter) => String(filter.id));
    const named = new Set(input.folder_ids);
    const missing = present.filter((id) => !named.has(id));
    const unknown = input.folder_ids.filter((id) => !present.includes(id));

    if (
      missing.length > 0 ||
      unknown.length > 0 ||
      named.size !== input.folder_ids.length
    ) {
      throw new GramScopeError(
        "INVALID_INPUT",
        `reorder takes the complete folder order, each id exactly once. The account holds [${present.join(", ")}]; this call named [${input.folder_ids.join(", ")}].`,
      );
    }

    const Api = await getApi();
    await client.invoke(
      new Api.messages.UpdateDialogFiltersOrder({
        order: input.folder_ids.map(Number),
      }),
    );
    return mapDialogFilters({ filters: await fetchRawFilters(client) });
  });
}
