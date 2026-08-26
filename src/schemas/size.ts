export const MAX_RESPONSE_BYTES = 256 * 1024;

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

/**
 * Returns how many leading items fit under the response cap. Always keeps at
 * least one item when the list is non-empty: an oversized single item is the
 * caller's problem to report, not a reason to return an empty page forever.
 */
export function fitToSizeCap<T>(
  items: T[],
  build: (kept: T[]) => unknown,
): number {
  if (items.length === 0) return 0;
  if (byteLength(build(items)) <= MAX_RESPONSE_BYTES) return items.length;

  let low = 1;
  let high = items.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (byteLength(build(items.slice(0, mid))) <= MAX_RESPONSE_BYTES) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}
