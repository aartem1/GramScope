import { describe, expect, it } from "vitest";
import { FANOUT_CONCURRENCY, mapWithConcurrency } from "@/concurrency";

describe("mapWithConcurrency", () => {
  it("preserves input order regardless of completion order", async () => {
    const items = [30, 10, 20, 0];
    const results = await mapWithConcurrency(items, 4, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms;
    });
    expect(results).toEqual(items);
  });

  it("never runs more than the ceiling at once", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 25 }, (_, i) => i),
      8,
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return 0;
      },
    );
    expect(peak).toBeLessThanOrEqual(8);
    expect(peak).toBeGreaterThan(1);
  });

  it("returns an empty array for no items", async () => {
    expect(await mapWithConcurrency([], 8, async () => 1)).toEqual([]);
  });

  it("rejects when a worker rejects", async () => {
    await expect(
      mapWithConcurrency([1, 2], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });

  it("uses a ceiling of 8 for the Telegram fan-out", () => {
    // 25 sources on one MTProto connection is what this ceiling exists to
    // prevent; the number is spec §7, not taste.
    expect(FANOUT_CONCURRENCY).toBe(8);
  });
});
