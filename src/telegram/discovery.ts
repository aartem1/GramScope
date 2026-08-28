import { fetchChannelDetails } from "./dialogs";
import type { SourceDetails } from "./dialogs";
import type { DialogIndex } from "./dialog-index";
import { entityMarkedId, entityUsernames, sourceType } from "./peer-id";
import type { DiscoveredSource } from "../schemas/discovery";
import type { TelegramLike } from "./client";
import {
  DISCOVERY_ENRICH_CONCURRENCY,
  mapWithConcurrency,
} from "../concurrency";

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
