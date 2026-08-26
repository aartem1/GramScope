import { beforeAll, describe, expect, it } from "vitest";
import { fetchFolders } from "@/telegram/folders";
import { getChannel, listDialogs } from "@/telegram/dialogs";
import { MAX_RESPONSE_BYTES } from "@/schemas/size";

const enabled = process.env.GRAMSCOPE_LIVE === "1";
const suite = enabled ? describe : describe.skip;

// House rule for this file: an assertion inside a `for` over a fetched list
// proves nothing when the list is empty, and an empty list is exactly what a
// broken query returns. Every loop below is preceded by an assertion (or a
// visible ctx.skip) on the length of what it iterates.
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
    if (!first.next_cursor) {
      ctx.skip();
      return;
    }
    const second = await listDialogs({ limit: 3, cursor: first.next_cursor });
    expect(
      second.sources.length,
      "a next_cursor was issued but the page it resumes is empty",
    ).toBeGreaterThan(0);

    const firstIds = new Set(first.sources.map((s) => s.id));
    for (const source of second.sources) {
      expect(firstIds.has(source.id)).toBe(false);
    }
  });

  it("keeps a max-limit page under the size cap", async () => {
    const page = await listDialogs({ limit: 200 });
    expect(page.sources.length).toBeGreaterThan(0);
    expect(
      Buffer.byteLength(JSON.stringify(page.sources), "utf8"),
    ).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
  });

  it("agrees between folder membership and folder_ids", async () => {
    // The guard on peer-id representation. Folder peer lists come from
    // InputPeer objects (bare ids); dialog ids come from teleproto's marked
    // form. If the two ever diverge again, no listed dialog matches any
    // folder and this fails loudly instead of skipping.
    const folders = await fetchFolders();
    const { sources } = await listDialogs({ limit: 200 });
    expect(sources.length).toBeGreaterThan(0);

    const populated = folders.filter((f) => f.included_peer_ids.length > 0);
    if (populated.length === 0) {
      throw new Error(
        "the account has no folder with members; add one before running the live suite",
      );
    }

    const members = sources.filter((s) =>
      populated.some((f) => f.included_peer_ids.includes(s.id)),
    );
    expect(
      members.length,
      "no listed dialog matched any folder's peer list — dialog ids and folder peer ids are in different representations",
    ).toBeGreaterThan(0);

    for (const source of members) {
      const expected = populated
        .filter(
          (f) =>
            f.included_peer_ids.includes(source.id) &&
            !f.excluded_peer_ids.includes(source.id),
        )
        .map((f) => f.id);
      expect(source.folder_ids ?? []).toEqual(
        expect.arrayContaining(expected),
      );
    }
  });

  it("returns folder members when filtering by folder_id", async (ctx) => {
    const folders = await fetchFolders();
    const { sources } = await listDialogs({ limit: 200 });
    const listed = new Set(sources.map((s) => s.id));

    // Choose a folder with at least one member on the page just fetched, so
    // an empty filtered result is a real failure and not just paging.
    const folder = folders.find((f) =>
      f.included_peer_ids.some((id) => listed.has(id)),
    );
    if (!folder) {
      ctx.skip();
      return;
    }

    const filtered = await listDialogs({ folder_id: folder.id, limit: 200 });
    expect(
      filtered.sources.length,
      `folder ${folder.id} has a member among the listed dialogs but filtering by it returned nothing`,
    ).toBeGreaterThan(0);

    for (const source of filtered.sources) {
      expect(folder.included_peer_ids).toContain(source.id);
      expect(source.folder_ids ?? []).toContain(folder.id);
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

    // Compare against the id list_dialogs emitted, not against each other:
    // all three get_channel results derive their id the same way, so they
    // agree by construction even when they disagree with list_dialogs — which
    // is exactly what happened while dialog and entity ids used different
    // representations.
    expect(byId.id).toBe(withUsername.id);
    expect(byUsername.id).toBe(withUsername.id);
    expect(byUrl.id).toBe(withUsername.id);
  });

  it("returns channel detail beyond what list_dialogs already carries", async (ctx) => {
    const { sources } = await listDialogs({ type: "channel", limit: 50 });
    const withUsername = sources.find((s) => s.username);
    if (!withUsername) {
      ctx.skip();
      return;
    }

    const detail = await getChannel({ id: withUsername.id });
    expect(detail.title).toBeTruthy();
    // description comes only from channels.getFullChannel; a public channel
    // may legitimately have an empty about, so this asserts the type, not
    // presence.
    if (detail.description !== undefined) {
      expect(typeof detail.description).toBe("string");
    }
    if (detail.linked_discussion_id !== undefined) {
      expect(detail.linked_discussion_id).toMatch(/^-100\d+$/);
    }
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
    const probed = before.sources.slice(0, 5);
    expect(probed.length).toBeGreaterThan(0);
    for (const source of probed) {
      await getChannel({ id: source.id });
    }

    const after = await listDialogs({ limit: 50 });
    expect(after.sources.length).toBeGreaterThan(0);
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
