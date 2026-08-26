import { describe, expect, it } from "vitest";
import { telegramSourceSchema } from "@/schemas/source";
import { telegramFolderSchema } from "@/schemas/folder";
import { fitToSizeCap, MAX_RESPONSE_BYTES } from "@/schemas/size";

describe("telegramSourceSchema", () => {
  it("accepts a minimal source", () => {
    const parsed = telegramSourceSchema.parse({
      id: "-1001234567890",
      title: "Example",
      type: "channel",
    });
    expect(parsed.username).toBeUndefined();
  });

  it("rejects an unknown type", () => {
    expect(() =>
      telegramSourceSchema.parse({ id: "1", title: "x", type: "bot" }),
    ).toThrow();
  });

  it("keeps unread bookkeeping fields", () => {
    const parsed = telegramSourceSchema.parse({
      id: "1",
      title: "x",
      type: "channel",
      unread_count: 7,
      read_inbox_max_id: 99,
      folder_ids: ["2"],
    });
    expect(parsed.unread_count).toBe(7);
    expect(parsed.read_inbox_max_id).toBe(99);
    expect(parsed.folder_ids).toEqual(["2"]);
  });
});

describe("telegramFolderSchema", () => {
  it("accepts a folder with both peer lists", () => {
    const parsed = telegramFolderSchema.parse({
      id: "2",
      title: "AI",
      included_peer_ids: ["1", "2"],
      excluded_peer_ids: [],
      order: 0,
    });
    expect(parsed.title).toBe("AI");
  });
});

describe("fitToSizeCap", () => {
  const build = (kept: string[]) => ({ sources: kept });

  it("keeps everything when small", () => {
    expect(fitToSizeCap(["a", "b", "c"], build)).toBe(3);
  });

  it("drops items that would exceed the cap", () => {
    const big = "x".repeat(50_000);
    const items = Array.from({ length: 20 }, () => big);
    const kept = fitToSizeCap(items, build);
    expect(kept).toBeLessThan(20);
    expect(
      Buffer.byteLength(JSON.stringify(build(items.slice(0, kept))), "utf8"),
    ).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
  });

  it("keeps at least one item even if it alone exceeds the cap", () => {
    const huge = "x".repeat(MAX_RESPONSE_BYTES * 2);
    expect(fitToSizeCap([huge], build)).toBe(1);
  });

  it("returns zero for an empty list", () => {
    expect(fitToSizeCap([], build)).toBe(0);
  });
});
