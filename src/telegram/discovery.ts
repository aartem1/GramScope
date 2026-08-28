import type { SourceDetails } from "./dialogs";
import type { DialogIndex } from "./dialog-index";
import { entityMarkedId, entityUsernames, sourceType } from "./peer-id";
import type { DiscoveredSource } from "../schemas/discovery";

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
