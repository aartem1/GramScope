import { FANOUT_CONCURRENCY, mapWithConcurrency } from "../concurrency";
import { GramScopeError } from "../errors/taxonomy";
import { mapTelegramError } from "../errors/from-telegram";
import type { TelegramLike } from "./client";
import type { DialogIndex } from "./dialog-index";
import { resolveSource, type ResolvedSource } from "./peer-resolve";

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
export const MAX_RAW_SOURCE_NAMES_PER_CALL = MAX_SOURCES_PER_CALL * 4;

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
      `This call names ${count} raw sources; the pre-resolution limit is ${MAX_RAW_SOURCE_NAMES_PER_CALL}. Split the call.`,
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
 * Resolves both sides of union-minus-exclusions to marked ids, then applies
 * exclusion and de-duplication while retaining the first selected handle.
 * Failed selected sources remain isolated result rows; an unresolved
 * exclusion fails the call because silently keeping it would violate the
 * caller's requested subtraction.
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
        return await resolveSource(client, index, handle);
      } catch (error) {
        throw mapTelegramError(error);
      }
    },
  );
  const excludedIds = new Set(exclusions.map((source) => source.source_id));

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
    if (item.resolved) {
      const id = item.resolved.source_id;
      if (excludedIds.has(id) || seenCanonical.has(id)) continue;
      seenCanonical.add(id);
      kept.push(item);
      continue;
    }

    const failureKey = item.target.handle.trim().toLowerCase();
    if (seenFailures.has(failureKey)) continue;
    seenFailures.add(failureKey);
    kept.push(item);
  }

  assertEffectiveSourceCount(kept.length);
  return kept;
}
