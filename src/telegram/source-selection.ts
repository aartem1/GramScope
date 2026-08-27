import { FANOUT_CONCURRENCY, mapWithConcurrency } from "../concurrency";
import { GramScopeError } from "../errors/taxonomy";
import { mapTelegramError } from "../errors/from-telegram";
import type { TelegramLike } from "./client";
import type { DialogIndex } from "./dialog-index";
import { entityUsernames } from "./peer-id";
import {
  nameKey,
  resolveSource,
  resolvesLocally,
  type ResolvedSource,
} from "./peer-resolve";

/**
 * Spec §5.1. A fan-out wider than this stops being one tool call and starts
 * being a job: 25 sources at limit 100 already fetches 2500 messages. Counted
 * over CANONICAL sources, because a caller naming one peer twice under two
 * names has still asked for one fan-out.
 */
export const MAX_SOURCES_PER_CALL = 25;

/**
 * Canonicalisation can collapse aliases, so the public ceiling above cannot be
 * applied before resolution. This guard bounds what resolution actually costs:
 * the names the dialog index cannot answer, which are the only ones that reach
 * the network. Selecting a whole folder and subtracting half of it is free by
 * this measure, because every folder member is a peer the account holds, while
 * a list of unjoined channels is charged in full.
 */
export const MAX_NETWORK_RESOLUTIONS_PER_CALL = MAX_SOURCES_PER_CALL * 2;

export type SourceTarget = { handle: string; offsetId: number };

export type PreparedSourceTarget = {
  target: SourceTarget;
  resolved?: ResolvedSource;
  error?: { code: string; message: string };
};

export function assertResolutionBudget(
  index: DialogIndex,
  names: string[],
): void {
  const count = names.filter((name) => !resolvesLocally(index, name)).length;
  if (count > MAX_NETWORK_RESOLUTIONS_PER_CALL) {
    throw new GramScopeError(
      "INVALID_INPUT",
      `This call names ${count} sources this account has not joined; at most ${MAX_NETWORK_RESOLUTIONS_PER_CALL} of those may be looked up in one call, and the call must resolve to at most ${MAX_SOURCES_PER_CALL} distinct sources. Split the call.`,
    );
  }
}

function assertEffectiveSourceCount(count: number): void {
  if (count === 0) {
    throw new GramScopeError(
      "INVALID_INPUT",
      "This selection resolves to no sources. Name at least one source, or pick a folder that has members.",
    );
  }
  if (count > MAX_SOURCES_PER_CALL) {
    throw new GramScopeError(
      "INVALID_INPUT",
      `This selection resolves to ${count} canonical sources; the limit is ${MAX_SOURCES_PER_CALL}. Split the call.`,
    );
  }
}

/** Every way this prepared target could be named, for matching against an
 *  exclusion that never resolved to a marked id of its own. */
function aliasKeys(item: PreparedSourceTarget): string[] {
  const keys = [nameKey(item.target.handle)];
  const source = item.resolved;
  if (source) {
    keys.push(`i:${source.source_id}`, nameKey(source.handle));
    // Every active handle, not just the one the source travels by: a peer with
    // collectible usernames answers to all of them, so an exclusion naming a
    // secondary one names this peer.
    for (const name of source.entity
      ? entityUsernames(source.entity)
      : source.username
        ? [source.username]
        : []) {
      keys.push(`u:${name.toLowerCase()}`);
    }
  }
  return keys;
}

/**
 * Resolves both sides of union-minus-exclusions to marked ids, then applies
 * exclusion and de-duplication while retaining the first selected handle.
 *
 * A failed SELECTED source stays as an isolated result row, so one dead
 * source does not cost the caller the whole page. An EXCLUSION that Telegram
 * says it cannot find degrades to matching by name key instead of failing the
 * call: taking the page down for it would break the common case of an agent
 * excluding an unjoined channel by the marked id it was handed, which a cold
 * instance cannot resolve. Any other exclusion failure still fails the call,
 * because it leaves the exclusion's status unknown. The residual gap — an
 * exclusion naming a defunct alias of a selected source silently fails to
 * exclude it — is what this code did before canonicalisation existed, and the
 * caller cannot tell the two apart anyway.
 */
export async function prepareSourceTargets(
  client: TelegramLike,
  index: DialogIndex,
  targets: SourceTarget[],
  excludedHandles: string[],
): Promise<PreparedSourceTarget[]> {
  assertResolutionBudget(index, [
    ...targets.map((target) => target.handle),
    ...excludedHandles,
  ]);

  const exclusions = await mapWithConcurrency(
    excludedHandles,
    FANOUT_CONCURRENCY,
    async (handle) => {
      try {
        return { id: (await resolveSource(client, index, handle)).source_id };
      } catch (error) {
        const mapped = mapTelegramError(error);
        // Only a name that resolves NOWHERE may degrade. A malformed name, an
        // invite link, a rate limit or a transport failure all mean the
        // exclusion's status is unknown, and serving content the caller asked
        // to omit on a guess is worse than failing the call.
        if (mapped.code !== "CHANNEL_NOT_FOUND") throw mapped;
        return { key: nameKey(handle) };
      }
    },
  );
  const excludedIds = new Set(
    exclusions.flatMap((item) => ("id" in item ? [item.id] : [])),
  );
  const excludedKeys = new Set(
    exclusions.flatMap((item) => ("key" in item ? [item.key] : [])),
  );

  const resolved = await mapWithConcurrency(
    targets,
    FANOUT_CONCURRENCY,
    async (target): Promise<PreparedSourceTarget> => {
      try {
        return {
          target,
          resolved: await resolveSource(client, index, target.handle),
        };
      } catch (error) {
        const mapped = mapTelegramError(error);
        return {
          target,
          error: { code: mapped.code, message: mapped.message },
        };
      }
    },
  );

  const seenCanonical = new Set<string>();
  const seenFailures = new Set<string>();
  const kept: PreparedSourceTarget[] = [];

  for (const item of resolved) {
    if (
      excludedKeys.size > 0 &&
      aliasKeys(item).some((key) => excludedKeys.has(key))
    ) {
      continue;
    }

    if (item.resolved) {
      const id = item.resolved.source_id;
      if (excludedIds.has(id) || seenCanonical.has(id)) continue;
      seenCanonical.add(id);
      kept.push(item);
      continue;
    }

    const failureKey = nameKey(item.target.handle);
    if (seenFailures.has(failureKey)) continue;
    seenFailures.add(failureKey);
    kept.push(item);
  }

  assertEffectiveSourceCount(kept.length);
  return kept;
}
