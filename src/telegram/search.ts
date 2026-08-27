import { getApi, withTelegram, type TelegramLike } from "./client";
import { fetchDialogIndex, type DialogIndex } from "./dialog-index";
import { mediaFilter, type MediaType } from "./message-slice";
import { parseDateBound } from "./messages";
import { inputPeerMarkedId } from "./peer-id";
import { readMessagesPage } from "./tl-messages";
import {
  assertSameScope,
  decodeSearchGlobalCursor,
  encodeSearchGlobalCursor,
  scopeFingerprint,
} from "../pagination";
import { fitToSizeCap, MAX_RESPONSE_BYTES } from "../schemas/size";
import { GramScopeError } from "../errors/taxonomy";
import {
  mapMessage,
  type MessageContext,
  type TelegramMessage,
} from "../schemas/message";

export type SearchInput = {
  query: string;
  source_ids?: string[];
  folder_ids?: string[];
  exclude_source_ids?: string[];
  from?: string;
  to?: string;
  media_type?: MediaType;
  limit: number;
  cursor?: string;
};

export type SearchHit = TelegramMessage & { source_title: string };

export type SearchSourceRollup = {
  source_id: string;
  title: string;
  hit_count: number;
  error?: { code: string; message: string };
};

export type SearchResult = {
  results: SearchHit[];
  sources: SearchSourceRollup[];
  total_matches?: number;
  next_cursor?: string;
};

export function isFanout(input: SearchInput): boolean {
  return (
    (input.source_ids?.length ?? 0) > 0 || (input.folder_ids?.length ?? 0) > 0
  );
}

export type SearchBounds = {
  fromSeconds?: number;
  toSeconds?: number;
  fingerprint: string;
};

export function prepareSearch(input: SearchInput): SearchBounds {
  if (input.query.trim().length === 0) {
    throw new GramScopeError("INVALID_INPUT", "query must not be empty");
  }
  if ((input.exclude_source_ids?.length ?? 0) > 0 && !isFanout(input)) {
    throw new GramScopeError(
      "INVALID_INPUT",
      "exclude_source_ids only applies when searching named sources. Telegram offers no exclusion for an account-wide search, and dropping excluded hits from a returned page would shrink it below limit. Pass source_ids or folder_ids, or drop the exclusion.",
    );
  }

  const fromSeconds = parseDateBound(input.from, "from");
  const toSeconds = parseDateBound(input.to, "to");
  if (
    fromSeconds !== undefined &&
    toSeconds !== undefined &&
    fromSeconds > toSeconds
  ) {
    throw new GramScopeError("INVALID_DATE_RANGE", "from is after to");
  }

  return {
    ...(fromSeconds !== undefined ? { fromSeconds } : {}),
    ...(toSeconds !== undefined ? { toSeconds } : {}),
    fingerprint: scopeFingerprint({
      q: input.query.trim(),
      sources: input.source_ids,
      folders: input.folder_ids,
      exclude: input.exclude_source_ids,
      from: fromSeconds,
      to: toSeconds,
      media: input.media_type,
    }),
  };
}

export function rollUp(hits: SearchHit[]): SearchSourceRollup[] {
  const byId = new Map<string, SearchSourceRollup>();
  for (const hit of hits) {
    const found = byId.get(hit.chat_id);
    if (found) found.hit_count++;
    else {
      byId.set(hit.chat_id, {
        source_id: hit.chat_id,
        title: hit.source_title,
        hit_count: 1,
      });
    }
  }
  return [...byId.values()];
}

function unixSeconds(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

async function searchFilter(mediaType: MediaType | undefined): Promise<unknown> {
  const Api = await getApi();
  return (await mediaFilter(mediaType)) ?? new Api.InputMessagesFilterEmpty();
}

function makePage(
  all: SearchHit[],
  kept: SearchHit[],
  input: SearchInput,
  nextRate: number | undefined,
  fingerprint: string,
  totalMatches: number | undefined,
): SearchResult {
  const last = kept[kept.length - 1];
  const complete = kept.length === all.length;
  const exhausted = complete && all.length < input.limit;
  const next_cursor =
    last !== undefined && !exhausted
      ? encodeSearchGlobalCursor({
          rate: complete ? (nextRate ?? unixSeconds(last.date)) : unixSeconds(last.date),
          peer: last.chat_id,
          id: last.id,
          fingerprint,
        })
      : undefined;

  return {
    results: kept,
    sources: rollUp(kept),
    ...(totalMatches !== undefined ? { total_matches: totalMatches } : {}),
    ...(next_cursor !== undefined ? { next_cursor } : {}),
  };
}

async function globalPage(
  client: TelegramLike,
  index: DialogIndex,
  input: SearchInput,
  bounds: SearchBounds,
): Promise<SearchResult> {
  const Api = await getApi();
  const cursor = input.cursor
    ? decodeSearchGlobalCursor(input.cursor)
    : undefined;
  if (cursor) assertSameScope(cursor.fingerprint, bounds.fingerprint);

  const page = readMessagesPage(
    await client.invoke(
      new Api.messages.SearchGlobal({
        q: input.query.trim(),
        filter: (await searchFilter(input.media_type)) as never,
        minDate: bounds.fromSeconds ?? 0,
        maxDate: bounds.toSeconds ?? 0,
        offsetRate: cursor?.rate ?? 0,
        offsetPeer: (cursor
          ? await client.getEntity(cursor.peer)
          : new Api.InputPeerEmpty()) as never,
        offsetId: cursor?.id ?? 0,
        limit: input.limit,
      }),
    ),
  );

  const all: SearchHit[] = page.messages.map((raw) => {
    const chatId = inputPeerMarkedId(raw.peerId) ?? "";
    const entry = index.byId.get(chatId);
    const context: MessageContext = {
      chatId,
      ...(entry?.username !== undefined ? { username: entry.username } : {}),
      ...(entry !== undefined
        ? { readInboxMaxId: entry.read_inbox_max_id }
        : {}),
    };
    return {
      ...mapMessage(raw, context),
      source_title: entry?.title ?? page.titles.get(chatId) ?? chatId,
    };
  });

  const fit = fitToSizeCap(all, (kept) =>
    makePage(all, kept, input, page.nextRate, bounds.fingerprint, page.count),
  );
  const result = makePage(
    all,
    all.slice(0, fit),
    input,
    page.nextRate,
    bounds.fingerprint,
    page.count,
  );

  if (Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_RESPONSE_BYTES) {
    return result;
  }

  throw new GramScopeError(
    "INTERNAL_ERROR",
    "The first matching message exceeds the 256 KB response limit.",
  );
}

export async function searchMessages(input: SearchInput): Promise<SearchResult> {
  const bounds = prepareSearch(input);
  const index = await fetchDialogIndex({ includeFolders: false });
  return withTelegram(async (client) => globalPage(client, index, input, bounds));
}
