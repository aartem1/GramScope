import { beforeAll, describe, expect, it } from "vitest";
import { fetchFolders } from "@/telegram/folders";
import { getChannel, listDialogs } from "@/telegram/dialogs";
import { MAX_RESPONSE_BYTES } from "@/schemas/size";

const enabled = process.env.GRAMSCOPE_LIVE === "1";
const suite = enabled ? describe : describe.skip;

suite("Foundation against the real account", () => {
  beforeAll(() => {
    if (!process.env.TELEGRAM_SESSION) {
      throw new Error("TELEGRAM_SESSION is required for live tests");
    }
  });

  it("lists dialogs", async () => {
    const { sources } = await listDialogs({ limit: 10 });
    expect(sources.length).toBeGreaterThan(0);
    expect(sources[0]!.id).toBeTruthy();
  });

  it("paginates into disjoint pages", async (ctx) => {
    const first = await listDialogs({ limit: 3 });
    // Skip visibly rather than pass silently: with fewer than four dialogs
    // there is no second page to compare, and a green tick here would be
    // mistaken for evidence that pagination works.
    if (!first.next_cursor) ctx.skip();
    const second = await listDialogs({ limit: 3, cursor: first.next_cursor });
    const firstIds = new Set(first.sources.map((s) => s.id));
    for (const source of second.sources) {
      expect(firstIds.has(source.id)).toBe(false);
    }
  });

  it("keeps a max-limit page under the size cap", async () => {
    const page = await listDialogs({ limit: 200 });
    expect(
      Buffer.byteLength(JSON.stringify(page.sources), "utf8"),
    ).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
  });

  it("agrees between folder membership and folder_ids", async (ctx) => {
    const folders = await fetchFolders();
    if (folders.length === 0) ctx.skip();
    const folder = folders[0]!;
    const { sources } = await listDialogs({
      folder_id: folder.id,
      limit: 200,
    });
    for (const source of sources) {
      expect(folder.included_peer_ids).toContain(source.id);
    }
  });

  it("resolves the same source by id, username and url", async (ctx) => {
    const { sources } = await listDialogs({ type: "channel", limit: 50 });
    const withUsername = sources.find((s) => s.username);
    if (!withUsername) {
      ctx.skip();
      return;
    }

    const byId = await getChannel({ id: withUsername.id });
    const byUsername = await getChannel({ username: withUsername.username! });
    const byUrl = await getChannel({
      url: `https://t.me/${withUsername.username!}`,
    });
    expect(byUsername.id).toBe(byId.id);
    expect(byUrl.id).toBe(byId.id);
  });

  it("does not advance any read pointer", async () => {
    const before = await listDialogs({ limit: 50 });
    const pointers = new Map(
      before.sources
        .filter((s) => s.read_inbox_max_id !== undefined)
        .map((s) => [s.id, s.read_inbox_max_id]),
    );

    // Refuse to pass vacuously. If no dialog reports a read pointer, the
    // comparison below would be undefined === undefined for every source and
    // would "pass" while proving nothing. This is the invariant every later
    // mark_read workflow rests on, so an unverifiable run must fail loudly.
    expect(
      pointers.size,
      "no dialog reported read_inbox_max_id, so read-safety cannot be verified",
    ).toBeGreaterThan(0);

    await fetchFolders();
    for (const source of before.sources.slice(0, 5)) {
      await getChannel({ id: source.id });
    }

    const after = await listDialogs({ limit: 50 });
    let compared = 0;
    for (const source of after.sources) {
      const expected = pointers.get(source.id);
      if (expected === undefined) continue;
      expect(source.read_inbox_max_id).toBe(expected);
      compared += 1;
    }
    expect(compared).toBeGreaterThan(0);
  });
});
