import { FANOUT_CONCURRENCY, mapWithConcurrency } from "../concurrency";
import { GramScopeError } from "../errors/taxonomy";
import { mapTelegramError } from "../errors/from-telegram";
import type { TelegramLike } from "./client";
import type { DialogIndex } from "./dialog-index";
import { nameKey, resolveSource, type ResolvedSource } from "./peer-resolve";

/**
 * Spec §5.1. A fan-out wider than this stops being one tool call and starts
 * being a job: 25 sources at limit 100 already fetches 2500 messages. Counted
 * over CANONICAL sources, because a caller naming one peer twice under two
 * names has still asked for one fan-out.
 */
export const MAX_SOURCES_PER_CALL = 25;

/**
 * Canonicalisation can collapse aliases, so the public ceiling cannot be
 * applied to raw names. This separate guard still bounds entity resolutions.
 */
export const MAX_RAW_SOURCE_NAMES_PER_CALL = MAX_SOURCES_PER_CALL * 2;

export type SourceTarget = { handle: string; offsetId: number };

export type PreparedSourceTarget = {
  target: SourceTarget;
  resolved?: ResolvedSource;
  error?: { code: string; message: string };
};

export function assertRawSourceCount(
  selectedCount: number,
  excludedCount: number,
): void {
  const count = selectedCount + excludedCount;
  if (count > MAX_RAW_SOURCE_NAMES_PER_CALL) {
    throw new GramScopeError(
      "INVALID_INPUT",
      `This call names ${count} sources and exclusions; at most ${MAX_RAW_SOURCE_NAMES_PER_CALL} names may be resolved in one call, and they must resolve to at most ${MAX_SOURCES_PER_CALL} distinct sources. Split the call.`,
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
    keys.push(`i:${source.source_id}`);
    if (source.username) keys.push(`u:${source.username.toLowerCase()}`);
    keys.push(nameKey(source.handle));
  }
  return keys;
}

/**
 * Resolves both sides of union-minus-exclusions to marked ids, then applies
 * exclusion and de-duplication while retaining the first selected handle.
 *
 * A failed SELECTED source stays as an isolated result row, so one dead
 * source does not cost the caller the whole page. A failed EXCLUSION degrades
 * to matching by name key instead of failing the call: an exclusion that
 * resolves nowhere cannot have matched any resolved source, and taking the
 * page down for it would break the common case of an agent excluding an
 * unjoined channel by the marked id it was handed, which a cold instance
 * cannot resolve. The residual gap — an exclusion naming a defunct alias of a
 * selected source silently fails to exclude it — is what this code did before
 * canonicalisation existed, and the caller cannot tell the two apart anyway.
 */
export async function prepareSourceTargets(
  client: TelegramLike,
  index: DialogIndex,
  targets: SourceTarget[],
  excludedHandles: string[],
): Promise<PreparedSourceTarget[]> {
  assertRawSourceCount(targets.length, excludedHandles.length);

  const exclusions = await mapWithConcurrency(
    excludedHandles,
    FANOUT_CONCURRENCY,
    async (handle) => {
      try {
        return { id: (await resolveSource(client, index, handle)).source_id };
      } catch {
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
