import { getApi, withTelegram, type TelegramLike } from "./client";
import {
  fetchDialogIndex,
  folderMembers,
  type DialogIndex,
} from "./dialog-index";
import { mediaFilter, type MediaType } from "./message-slice";
import { MAX_SOURCES_PER_CALL, parseDateBound } from "./messages";
import { inputPeerMarkedId } from "./peer-id";
import {
  parseTelegramName,
  resolveSource,
  type ResolvedSource,
} from "./peer-resolve";
import { readMessagesPage } from "./tl-messages";
import {
  assertSameScope,
  decodeSearchGlobalCursor,
  decodeSearchSourcesCursor,
  encodeSearchGlobalCursor,
  encodeSearchSourcesCursor,
  scopeFingerprint,
} from "../pagination";
import { fitToSizeCap, MAX_RESPONSE_BYTES } from "../schemas/size";
import { GramScopeError } from "../errors/taxonomy";
import { mapTelegramError } from "../errors/from-telegram";
import { FANOUT_CONCURRENCY, mapWithConcurrency } from "../concurrency";
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

/** One key per way of naming the same peer, so an exclusion written as
 * @name removes a folder member listed by id once that member resolves. */
function nameKeys(source: {
  source_id?: string;
  username?: string;
  handle?: string;
}): string[] {
  const keys: string[] = [];
  if (source.source_id) keys.push(`i:${source.source_id}`);
  if (source.username) keys.push(`u:${source.username.toLowerCase()}`);
  if (source.handle) {
    keys.push(nameKey(source.handle));
  }
  return keys;
}

function nameKey(raw: string): string {
  const link = parseTelegramName(raw);
  if (link.kind === "username") return `u:${link.username.toLowerCase()}`;
  if (link.kind === "internal") return `i:${link.markedId}`;
  return `v:${link.hash}`;
}

function targetNames(input: SearchInput, index: DialogIndex): string[] {
  const excluded = new Set((input.exclude_source_ids ?? []).map(nameKey));
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const name of [
    ...(input.source_ids ?? []),
    ...folderMembers(index.folders, input.folder_ids ?? []),
  ]) {
    const key = nameKey(name);
    if (excluded.has(key) || seen.has(key)) continue;
    seen.add(key);
    ordered.push(name);
  }

  if (ordered.length === 0) {
    throw new GramScopeError(
      "INVALID_INPUT",
      "This selection resolves to no sources. Name at least one source, or pick a folder that has members.",
    );
  }
  if (ordered.length > MAX_SOURCES_PER_CALL) {
    throw new GramScopeError(
      "INVALID_INPUT",
      `This selection resolves to ${ordered.length} sources; the limit is ${MAX_SOURCES_PER_CALL}. Split the call.`,
    );
  }
  return ordered;
}

type Outcome = {
  source_id: string;
  title: string;
  handle: string;
  /** Where this page started reading; the resume point if it served nothing. */
  startOffsetId: number;
  hits: SearchHit[];
  fetched: number;
  count?: number;
  error?: { code: string; message: string };
};

async function sourcesPage(
  client: TelegramLike,
  index: DialogIndex,
  input: SearchInput,
  bounds: SearchBounds,
): Promise<SearchResult> {
  const Api = await getApi();
  const cursor = input.cursor
    ? decodeSearchSourcesCursor(input.cursor)
    : undefined;
  if (cursor) assertSameScope(cursor.fingerprint, bounds.fingerprint);

  // A cursor carries its own source set, so a continuation never re-derives
  // one from folder membership that may have changed between pages.
  const targets = cursor
    ? cursor.sources
    : targetNames(input, index).map((handle) => ({ handle, offsetId: 0 }));

  // Resolution first, in its own pass: it is free for peers the account holds,
  // and doing it before the searches means an excluded source never costs a
  // request.
  type Target = {
    target: (typeof targets)[number];
    resolved?: ResolvedSource;
    error?: Outcome;
  };
  const prepared: Target[] = await mapWithConcurrency(
    targets,
    FANOUT_CONCURRENCY,
    async (target) => {
      try {
        return {
          target,
          resolved: await resolveSource(client, index, target.handle),
        };
      } catch (err) {
        const mapped = mapTelegramError(err);
        return {
          target,
          error: {
            source_id: target.handle,
            title: target.handle,
            handle: target.handle,
            startOffsetId: target.offsetId,
            hits: [],
            fetched: 0,
            error: { code: mapped.code, message: mapped.message },
          },
        };
      }
    },
  );

  const excluded = new Set((input.exclude_source_ids ?? []).map(nameKey));
  const kept = cursor
    ? prepared
    : prepared.filter(
        (item) =>
          item.resolved === undefined ||
          !nameKeys(item.resolved).some((key) => excluded.has(key)),
      );

  const filter = await searchFilter(input.media_type);
  const outcomes: Outcome[] = await mapWithConcurrency(
    kept,
    FANOUT_CONCURRENCY,
    async (item): Promise<Outcome> => {
      if (item.error) return item.error;
      const source = item.resolved!;
      const base = {
        source_id: source.source_id,
        title: source.title,
        handle: source.handle,
        startOffsetId: item.target.offsetId,
      };
      try {
        // Every field explicit: teleproto does not fill TL defaults for
        // omitted non-flag parameters.
        const page = readMessagesPage(
          await client.invoke(
            new Api.messages.Search({
              peer: source.handle as never,
              q: input.query.trim(),
              filter: filter as never,
              minDate: bounds.fromSeconds ?? 0,
              maxDate: bounds.toSeconds ?? 0,
              offsetId: item.target.offsetId,
              addOffset: 0,
              limit: input.limit,
              maxId: 0,
              minId: 0,
              hash: 0 as never,
            }),
          ),
        );

        const entry = index.byId.get(source.source_id);
        const context: MessageContext = {
          chatId: source.source_id,
          ...(source.username !== undefined
            ? { username: source.username }
            : {}),
          ...(entry !== undefined
            ? { readInboxMaxId: entry.read_inbox_max_id }
            : {}),
        };

        return {
          ...base,
          hits: page.messages.map((raw) => ({
            ...mapMessage(raw, context),
            source_title: source.title,
          })),
          fetched: page.messages.length,
          ...(page.count !== undefined ? { count: page.count } : {}),
        };
      } catch (err) {
        // House rule: one dead source must not cost the page.
        const mapped = mapTelegramError(err);
        return {
          ...base,
          hits: [],
          fetched: 0,
          error: { code: mapped.code, message: mapped.message },
        };
      }
    },
  );

  type Unit = { outcomeIndex: number; hit: SearchHit };
  const merged: Unit[] = outcomes
    .flatMap((outcome, outcomeIndex) =>
      outcome.hits.map((hit) => ({ outcomeIndex, hit })),
    )
    .sort(
      (a, b) =>
        Date.parse(b.hit.date) - Date.parse(a.hit.date) || b.hit.id - a.hit.id,
    );

  const totals = outcomes
    .map((outcome) => outcome.count)
    .filter((count): count is number => count !== undefined);
  const total_matches =
    totals.length > 0 ? totals.reduce((sum, count) => sum + count, 0) : undefined;

  const compose = (units: Unit[]): SearchResult => {
    const servedCount = new Array<number>(outcomes.length).fill(0);
    for (const unit of units) servedCount[unit.outcomeIndex]!++;
    return {
      results: units.map((unit) => unit.hit),
      sources: outcomes.map((outcome, i) => ({
        source_id: outcome.source_id,
        title: outcome.title,
        hit_count: servedCount[i]!,
        ...(outcome.error ? { error: outcome.error } : {}),
      })),
      ...(total_matches !== undefined ? { total_matches } : {}),
    };
  };

  const render = (served: Unit[]): SearchResult => {
    // Per source: the oldest hit actually served is the resume point, its
    // start offset if it served none, and nothing if it is exhausted or failed.
    const unexhausted: Array<{ handle: string; offsetId: number }> = [];
    for (let i = 0; i < outcomes.length; i++) {
      const outcome = outcomes[i]!;
      if (outcome.error) continue;
      const servedHits = served
        .filter((unit) => unit.outcomeIndex === i)
        .map((unit) => unit.hit);
      const exhausted =
        servedHits.length === outcome.hits.length &&
        outcome.fetched < input.limit;
      if (exhausted) continue;
      unexhausted.push({
        handle: outcome.handle,
        offsetId:
          servedHits.length > 0
            ? Math.min(...servedHits.map((hit) => hit.id))
            : outcome.startOffsetId,
      });
    }

    return {
      ...compose(served),
      ...(unexhausted.length > 0
        ? {
            next_cursor: encodeSearchSourcesCursor({
              sources: unexhausted,
              fingerprint: bounds.fingerprint,
            }),
          }
        : {}),
    };
  };

  const limited = merged.slice(0, input.limit);
  const fit = fitToSizeCap(limited, render);
  const result = render(limited.slice(0, fit));
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
  const index = await fetchDialogIndex({
    includeFolders: isFanout(input),
  });
  return withTelegram(async (client) =>
    isFanout(input)
      ? sourcesPage(client, index, input, bounds)
      : globalPage(client, index, input, bounds),
  );
}
