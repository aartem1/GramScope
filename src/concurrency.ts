/**
 * Spec §7: 25 sources must not become 25 simultaneous MTProto requests on one
 * connection.
 */
export const FANOUT_CONCURRENCY = 8;

/**
 * Runs `fn` over `items` with at most `limit` calls in flight, returning
 * results in input order. Rejects as soon as any call rejects; callers that
 * need per-item failure isolation catch inside `fn` and return a value.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from(
    { length: Math.max(0, Math.min(limit, items.length)) },
    async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await fn(items[index]!);
      }
    },
  );

  await Promise.all(workers);
  return results;
}
