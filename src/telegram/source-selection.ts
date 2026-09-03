import { FANOUT_CONCURRENCY, mapWithConcurrency } from "../concurrency";
import { GramScopeError } from "../errors/taxonomy";
import { mapTelegramError } from "../errors/from-telegram";
import { MAX_SOURCES_PER_CALL } from "../limits";
import type { TelegramLike } from "./client";
import type { DialogIndex } from "./dialog-index";
import { entityUsernames } from "../peer-id";
import {
  localSourceId,
  nameKey,
  parseTelegramName,
  resolutionCost,
  resolveSource,
  type ResolvedSource,
} from "./peer-resolve";

export { MAX_SOURCES_PER_CALL } from "../limits";

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

/**
 * A sanity bound on the size of the request itself. Every name still costs a
 * parse and two map lookups, and the arrays reaching here are caller-supplied,
 * so something has to be O(1) in the caller's generosity. Set far above any
 * real selection — Telegram caps a folder at 100 members, 200 with Premium —
 * so it never decides a legitimate call.
 */
export const MAX_SOURCE_NAMES_PER_CALL = 1000;

/**
 * Rejects, before spending a single lookup, everything that can be decided
 * without one. Three checks, cheapest first.
 *
 * The effective ceiling cannot be checked in full here, because two names the
 * index cannot answer may still resolve to one peer, so counting names is an
 * UPPER bound on the canonical set and rejecting on it would refuse legal
 * calls. What is exact is the held half: those names canonicalise for free.
 * Network exclusions are subtracted from it because one of them may yet remove
 * a held source — that is what keeps the bound below the true count.
 */
export function assertResolutionBudget(
  index: DialogIndex,
  selected: string[],
  excluded: string[],
): void {
  const total = selected.length + excluded.length;
  if (total > MAX_SOURCE_NAMES_PER_CALL) {
    throw new GramScopeError(
      "INVALID_INPUT",
      `This call names ${total} sources and exclusions; at most ${MAX_SOURCE_NAMES_PER_CALL} names fit in one call. Split the call.`,
    );
  }

  const heldSelected = new Set<string>();
  for (const name of selected) {
    const id = localSourceId(index, name);
    if (id) heldSelected.add(id);
  }
  let networkExcluded = 0;
  for (const name of excluded) {
    const id = localSourceId(index, name);
    if (id) heldSelected.delete(id);
    else if (resolutionCost(index, name) === "network") networkExcluded += 1;
  }

  const atLeast = heldSelected.size - networkExcluded;
  if (atLeast > MAX_SOURCES_PER_CALL) {
    throw new GramScopeError(
      "INVALID_INPUT",
      `This selection already names ${atLeast} sources this account has joined; the limit is ${MAX_SOURCES_PER_CALL}. Split the call.`,
    );
  }

  const lookups = [...selected, ...excluded].filter(
    (name) => resolutionCost(index, name) === "network",
  ).length;
  if (lookups > MAX_NETWORK_RESOLUTIONS_PER_CALL) {
    throw new GramScopeError(
      "INVALID_INPUT",
      `This call names ${lookups} sources this account has not joined; at most ${MAX_NETWORK_RESOLUTIONS_PER_CALL} of those may be looked up in one call, and the call must resolve to at most ${MAX_SOURCES_PER_CALL} distinct sources. Split the call.`,
    );
  }
}

/**
 * The source_ids bound every write tool enforces before touching the
 * network: reject an empty or an over-limit selection up front. Lives here,
 * not in each tool's own module, because this module already owns the
 * question "how many sources may one call name" (MAX_SOURCES_PER_CALL,
 * assertResolutionBudget above) — markRead and markUnread shared this guard
 * verbatim before this extraction, and folder editing is a third caller.
 *
 * The ceiling is a parameter rather than a constant baked in here because
 * callers reach for different ceilings that happen to share a value today:
 * mark_read and mark_unread pass MAX_MARK_READ_SOURCES, folder editing will
 * pass MAX_SOURCES_PER_CALL — same number, different meaning, and nothing
 * here should assume they stay equal.
 */
export function assertSourceIdsBounded(
  sourceIds: string[],
  toolName: string,
  limit: number,
): void {
  if (sourceIds.length === 0) {
    throw new GramScopeError(
      "INVALID_INPUT",
      "source_ids must name at least one source",
    );
  }
  if (sourceIds.length > limit) {
    throw new GramScopeError(
      "INVALID_INPUT",
      `${toolName} accepts at most ${limit} sources per call; got ${sourceIds.length}. Split the call.`,
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

/**
 * Whether a failed exclusion may fall back to matching by name, rather than
 * failing the call.
 *
 * `CHANNEL_NOT_FOUND` means the name resolves nowhere, which is the
 * cold-instance case this exists for. `PRIVATE_CHANNEL_NOT_ACCESSIBLE` joins it
 * only for a marked id: there the peer's identity is precisely what the caller
 * wrote, so the degrade key is exact — a channel the account was banned from
 * would otherwise take the whole page down for an exclusion that is provably a
 * no-op. For a username no id is learned, so the exclusion's target stays
 * unknown. Every other failure — a malformed name, an invite link, a rate
 * limit, a transport error — leaves the status unknown, and serving content the
 * caller asked to omit on a guess is worse than failing.
 */
function degrades(code: string, handle: string): boolean {
  if (code === "CHANNEL_NOT_FOUND") return true;
  if (code !== "PRIVATE_CHANNEL_NOT_ACCESSIBLE") return false;
  try {
    return parseTelegramName(handle).kind === "internal";
  } catch {
    return false;
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
  assertResolutionBudget(
    index,
    targets.map((target) => target.handle),
    excludedHandles,
  );

  const exclusions = await mapWithConcurrency(
    excludedHandles,
    FANOUT_CONCURRENCY,
    async (handle) => {
      try {
        return { id: (await resolveSource(client, index, handle)).source_id };
      } catch (error) {
        const mapped = mapTelegramError(error);
        if (!degrades(mapped.code, handle)) throw mapped;
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
