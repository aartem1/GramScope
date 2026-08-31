export type ByteRange = { start: number; end: number; length: number };

export class RangeNotSatisfiableError extends Error {
  constructor(public readonly size: number) {
    super("Requested byte range is not satisfiable");
    this.name = "RangeNotSatisfiableError";
  }
}

export function parseSingleRange(
  header: string | null,
  size: number,
): ByteRange | undefined {
  if (header === null) return undefined;
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new RangeNotSatisfiableError(size);
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) {
    throw new RangeNotSatisfiableError(size);
  }
  if (size === 0) throw new RangeNotSatisfiableError(size);
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) {
      throw new RangeNotSatisfiableError(size);
    }
    const length = Math.min(suffix, size);
    return { start: size - length, end: size - 1, length };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] === "" ? size - 1 : Number(match[2]);
  const end = Math.min(requestedEnd, size - 1);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start ||
    end < start
  ) {
    throw new RangeNotSatisfiableError(size);
  }
  return { start, end, length: end - start + 1 };
}
