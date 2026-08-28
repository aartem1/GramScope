import { beforeAll, describe, expect, it } from "vitest";
import { searchChannels, getSimilarChannels } from "@/telegram/discovery";
import { fetchDialogIndex } from "@/telegram/dialog-index";

const enabled = process.env.GRAMSCOPE_LIVE === "1";
const suite = enabled ? describe : describe.skip;

// House rule for this file: an assertion inside a `for` over a fetched list
// proves nothing when the list is empty, and an empty list is exactly what a
// broken query returns. Every loop below is preceded by an assertion (or a
// visible ctx.skip) on the length of what it iterates.
suite("Discovery against the real account", () => {
  beforeAll(() => {
    if (!process.env.TELEGRAM_SESSION) {
      throw new Error("TELEGRAM_SESSION is required for live tests");
    }
  });

  it("finds public channels by name", async () => {
    // Measured 2026-08-28 to return ten channels on this account. A one-word
    // abbreviation would return nothing and prove only that the tool runs.
    const { candidates } = await searchChannels({ query: "нейросети" });
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.id).toBeTruthy();
      expect(candidate.title).toBeTruthy();
      expect(typeof candidate.joined).toBe("boolean");
    }
  });

  it("gives found channels a usable @username", async () => {
    // The §6 risk. contacts.search returns username: null for collectible
    // handles; if entityUsernames drops them for want of `active`, a candidate
    // ships with no durable handle and get_messages cannot read it later.
    // The threshold is half rather than all: the failure being guarded is
    // all-or-nothing — a predicate that drops every collectible handle — so
    // half catches it while one odd handle-less channel cannot flake the run.
    const { candidates } = await searchChannels({ query: "нейросети" });
    expect(candidates.length).toBeGreaterThan(0);
    const named = candidates.filter((c) => c.username);
    expect(named.length).toBeGreaterThanOrEqual(
      Math.ceil(candidates.length / 2),
    );
    for (const candidate of named) {
      expect(candidate.url).toBe(`https://t.me/${candidate.username}`);
    }
  });

  it("describes at least one found channel", async () => {
    const { candidates } = await searchChannels({ query: "нейросети" });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.some((c) => (c.description ?? "").length > 0)).toBe(true);
  });

  it("recommends neighbours of a channel the account follows", async () => {
    const index = await fetchDialogIndex();
    const seed = [...index.byId.values()].find((entry) => entry.username);
    expect(seed, "the account follows no channel with a username").toBeTruthy();

    const result = await getSimilarChannels({ source: `@${seed!.username}` });
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.total_similar).toBeGreaterThan(result.candidates.length);
    expect(result.truncated).toBe(true);
  });

  it("recommends channels for the account as a whole", async () => {
    const { candidates, total_similar } = await getSimilarChannels({});
    expect(candidates.length).toBeGreaterThan(0);
    expect(total_similar).toBeUndefined();
  });

  it("survives two discovery calls back to back", async () => {
    // Two calls in a row is the shape that floods getFullChannel. This asserts
    // the pair completes and agrees, not that the second was faster: the cache
    // itself is pinned deterministically in the fast tier, and a wall-clock
    // comparison against a live network is a flake generator.
    const first = await getSimilarChannels({});
    const second = await getSimilarChannels({});
    expect(first.candidates.length).toBeGreaterThan(0);
    expect(second.candidates.map((c) => c.id)).toEqual(
      first.candidates.map((c) => c.id),
    );
  });

  it("reports joined for a candidate the account already follows", async (ctx) => {
    const { candidates } = await getSimilarChannels({});
    expect(candidates.length).toBeGreaterThan(0);
    const held = candidates.filter((c) => c.joined);
    // Skip visibly rather than pass silently: recommendations are mostly
    // channels the account does NOT follow, and a green tick over an empty
    // list would be mistaken for evidence that `joined` works.
    if (held.length === 0) {
      ctx.skip();
      return;
    }
    const index = await fetchDialogIndex();
    for (const candidate of held) {
      expect(index.byId.has(candidate.id)).toBe(true);
    }
  });
});
