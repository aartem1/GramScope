/**
 * Unwraps the shapes teleproto uses for Telegram ids — bigint, number, string,
 * or a BigInteger-like `{ value }` wrapper — into a decimal string. Shared so
 * folders and dialogs cannot drift apart on id handling.
 */
export function readBigId(value: unknown): string | undefined {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "value" in value) {
    return readBigId((value as { value: unknown }).value);
  }
  return undefined;
}
