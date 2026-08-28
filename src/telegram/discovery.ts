import { fetchChannelDetails } from "./dialogs";
import type { SourceDetails } from "./dialogs";
import type { DialogIndex } from "./dialog-index";
import {
  entityMarkedId,
  entityUsernames,
  readBigId,
  sourceType,
} from "./peer-id";
import type { DiscoveredSource } from "../schemas/discovery";
import type { TelegramLike } from "./client";
import { getApi, withTelegram } from "./client";
import { fetchDialogIndex } from "./dialog-index";
import { GramScopeError } from "../errors/taxonomy";
import { fitToSizeCap } from "../schemas/size";
import {
  DISCOVERY_ENRICH_CONCURRENCY,
  mapWithConcurrency,
} from "../concurrency";
import { resolveSource } from "./peer-resolve";

/**
 * Builds one candidate from a TL entity. Pure: everything it needs is either
 * on the entity, in the already-loaded dialog index, or in `details` fetched
 * by the caller.
 */
export function toCandidate(
  entity: Record<string, unknown>,
  index: DialogIndex,
  details: SourceDetails = {},
): DiscoveredSource {
  const id = entityMarkedId(entity) ?? "";
  // entityUsernames, not entityUsername: contacts.search returns collectible
  // handles only in usernames[], with username itself null.
  const username = entityUsernames(entity)[0];
  const description =
    details.description ??
    (typeof entity.about === "string" ? entity.about : undefined);

  return {
    id,
    title: typeof entity.title === "string" ? entity.title : "",
    ...(username ? { username, url: `https://t.me/${username}` } : {}),
    ...(description ? { description } : {}),
    type: sourceType(entity),
    ...(typeof entity.participantsCount === "number"
      ? { subscriber_count: entity.participantsCount }
      : {}),
    joined: id !== "" && index.byId.has(id),
    verified: entity.verified === true,
    scam: entity.scam === true,
    fake: entity.fake === true,
    restricted: entity.restricted === true,
  };
}

/** Half the measured flood threshold, so one call can never flood alone. */
export const MAX_ENRICHED_CANDIDATES = 10;

/**
 * Marked id to fetched details, for the life of the serverless instance. A
 * channel's `about` changes rarely and recommendation sets overlap heavily
 * between calls, so this is what keeps two discovery calls in one conversation
 * from summing past the flood threshold. It holds description and linked-chat
 * only; `joined`, unread state and folder membership are never cached, because
 * those change while `about` does not.
 */
const detailsCache = new Map<string, SourceDetails>();

export function __resetDiscoveryCacheForTests(): void {
  detailsCache.clear();
}

/**
 * Fetches a description per candidate, in input order, under all three flood
 * guards. Cuts to MAX_ENRICHED_CANDIDATES first: cutting after fetching would
 * spend exactly the requests the ceiling exists to prevent.
 *
 * A failure yields {} and is NOT cached — caching it would make one transient
 * FLOOD_WAIT permanent for the life of the instance. A candidate without a
 * description is a valid candidate; a discovery call that dies because one
 * channel of ten refused a full-info request is not.
 */
export async function enrichCandidates(
  client: TelegramLike,
  entities: Record<string, unknown>[],
): Promise<SourceDetails[]> {
  const kept = entities.slice(0, MAX_ENRICHED_CANDIDATES);
  return mapWithConcurrency(
    kept,
    DISCOVERY_ENRICH_CONCURRENCY,
    async (entity) => {
      const id = entityMarkedId(entity) ?? "";
      const cached = detailsCache.get(id);
      if (cached) return cached;

      const details = await fetchChannelDetails(client, entity).catch(
        () => ({}) as SourceDetails,
      );
      if (
        details.description !== undefined ||
        details.linkedDiscussionId !== undefined
      ) {
        detailsCache.set(id, details);
      }
      return details;
    },
  );
}

/**
 * Measured 2026-08-28: contacts.search caps global results at 10 whatever
 * `limit` says — 50 and 200 returned the same page — and offers no offset.
 * A full page is therefore the only available signal that more may exist.
 */
const CONTACTS_SEARCH_CAP = 10;

export type SearchChannelsInput = { query: string; limit?: number };

export type SearchChannelsResult = {
  candidates: DiscoveredSource[];
  truncated: boolean;
};

/**
 * Channel entities from a contacts.Found, in Telegram's order with the
 * account's own matches first, each peer once. A PeerUser has no channelId, so
 * users fall out here rather than needing a separate filter.
 */
function channelEntities(found: unknown): Record<string, unknown>[] {
  const reply = (found ?? {}) as {
    myResults?: unknown[];
    results?: unknown[];
    chats?: unknown[];
  };

  const byBareId = new Map<string, Record<string, unknown>>();
  for (const chat of Array.from(reply.chats ?? [])) {
    const bare = readBigId((chat as { id?: unknown }).id);
    if (bare !== undefined) byBareId.set(bare, chat as Record<string, unknown>);
  }

  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const peer of [
    ...Array.from(reply.myResults ?? []),
    ...Array.from(reply.results ?? []),
  ]) {
    const bare = readBigId((peer as { channelId?: unknown }).channelId);
    if (bare === undefined) continue;
    const entity = byBareId.get(bare);
    if (entity === undefined) continue;
    const marked = entityMarkedId(entity);
    if (marked === undefined || seen.has(marked)) continue;
    seen.add(marked);
    out.push(entity);
  }
  return out;
}

export async function searchChannels(
  input: SearchChannelsInput,
): Promise<SearchChannelsResult> {
  const query = (input.query ?? "").trim();
  if (query.length === 0) {
    throw new GramScopeError("INVALID_INPUT", "query must not be empty");
  }
  const limit = input.limit ?? MAX_ENRICHED_CANDIDATES;

  const index = await fetchDialogIndex();

  return withTelegram(async (client) => {
    const Api = await getApi();
    const found = await client.invoke(
      new Api.contacts.Search({
        q: query,
        limit: CONTACTS_SEARCH_CAP,
        // Not an option: it costs nothing, and the quota it frees refills
        // with channels, which is what this product reads.
        broadcasts: true,
      }),
    );

    const entities = channelEntities(found);
    const kept = entities.slice(0, limit);
    const details = await enrichCandidates(client, kept);
    const candidates = kept.map((entity, i) =>
      toCandidate(entity, index, details[i]),
    );

    const fit = fitToSizeCap(candidates, (shown) => ({
      candidates: shown,
      truncated: true,
    }));
    const shown = candidates.slice(0, fit);

    return {
      candidates: shown,
      // One meaning in both tools: the server held more than this response
      // carries — whether Telegram capped the page or `limit` cut it.
      truncated:
        shown.length < entities.length ||
        entities.length >= CONTACTS_SEARCH_CAP,
    };
  });
}

export type SimilarChannelsInput = { source?: string; limit?: number };

export type SimilarChannelsResult = {
  candidates: DiscoveredSource[];
  total_similar?: number;
  truncated: boolean;
};

/**
 * Telegram's own recommendations. With a source: channels similar to it,
 * returned as a ChatsSlice whose `count` exceeds what it serves — the rest is
 * Premium-only and no argument reaches it. Without a source: channels
 * recommended for the account from its own subscriptions, returned as a plain
 * Chats with no count. One TL method, and the mode follows the argument.
 */
export async function getSimilarChannels(
  input: SimilarChannelsInput,
): Promise<SimilarChannelsResult> {
  const limit = input.limit ?? MAX_ENRICHED_CANDIDATES;
  const index = await fetchDialogIndex();

  return withTelegram(async (client) => {
    const Api = await getApi();

    const request = input.source
      ? new Api.channels.GetChannelRecommendations({
          channel: (await resolveSource(client, index, input.source)).handle,
        })
      : new Api.channels.GetChannelRecommendations({});

    const reply = (await client.invoke(request)) as {
      chats?: unknown[];
      count?: unknown;
    };

    const chats = Array.from(reply.chats ?? []) as Record<string, unknown>[];
    const total = typeof reply.count === "number" ? reply.count : undefined;

    const kept = chats.slice(0, limit);
    const details = await enrichCandidates(client, kept);
    const candidates = kept.map((entity, i) =>
      toCandidate(entity, index, details[i]),
    );

    const fit = fitToSizeCap(candidates, (shown) => ({
      candidates: shown,
      truncated: true,
    }));
    const shown = candidates.slice(0, fit);

    return {
      candidates: shown,
      ...(total !== undefined ? { total_similar: total } : {}),
      truncated:
        shown.length < chats.length ||
        (total !== undefined && total > shown.length),
    };
  });
}
