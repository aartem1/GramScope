import { beforeAll, describe, expect, it } from "vitest";
import { getMessage, getMessages } from "@/telegram/messages";
import { getUnreadSummary } from "@/telegram/unread";
import { markRead } from "@/telegram/read-state";
import { fetchFolders } from "@/telegram/folders";
import { MAX_RESPONSE_BYTES } from "@/schemas/size";

const enabled = process.env.GRAMSCOPE_LIVE === "1";
const suite = enabled ? describe : describe.skip;

async function populatedFolder() {
  const folders = await fetchFolders();
  const folder = folders.find(
    (candidate) => candidate.included_peer_ids.length > 1,
  );
  if (!folder) {
    throw new Error(
      "the live suite needs a folder with at least two members; add one before running it",
    );
  }
  return folder;
}

// House rule inherited from foundation.live.test.ts: an assertion inside a
// `for` over a fetched list proves nothing when the list is empty, and an
// empty list is exactly what a broken query returns. Every loop below is
// preceded by an assertion (or a visible ctx.skip) on the length of what it
// iterates.
suite("Reading against the real account", () => {
  beforeAll(() => {
    if (!process.env.TELEGRAM_SESSION) {
      throw new Error("TELEGRAM_SESSION is required for live tests");
    }
  });

  it("fans out over a real folder in one call", async () => {
    const folder = await populatedFolder();
    const page = await getMessages({ folder_ids: [folder.id], limit: 5 });

    expect(page.sources.length).toBeGreaterThan(1);
    const withMessages = page.sources.filter(
      (source) => (source.messages?.length ?? 0) > 0,
    );
    expect(
      withMessages.length,
      "every source in the folder came back empty; the fan-out is not reading",
    ).toBeGreaterThan(0);

    for (const source of withMessages) {
      expect(source.title).toBeTruthy();
      expect(source.messages![0]!.chat_id).toBe(source.source_id);
      // Newest first, per spec §7.
      const ids = source.messages!.map((message) => message.id);
      expect([...ids].sort((a, b) => b - a)).toEqual(ids);
    }
  });

  it("keeps a wide page under the size cap", async () => {
    const folder = await populatedFolder();
    const page = await getMessages({ folder_ids: [folder.id], limit: 100 });
    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(
      MAX_RESPONSE_BYTES,
    );
  });

  it("reads a date window regardless of read state", async () => {
    const folder = await populatedFolder();
    const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const page = await getMessages({
      folder_ids: [folder.id],
      from: weekAgo,
      limit: 20,
    });

    const messages = page.sources.flatMap((source) => source.messages ?? []);
    expect(
      messages.length,
      "no messages in the past week; pick a busier folder for the live suite",
    ).toBeGreaterThan(0);
    for (const message of messages) {
      expect(Date.parse(message.date)).toBeGreaterThanOrEqual(
        Date.parse(weekAgo),
      );
    }
    // The window must not be silently filtered by read state.
    expect(messages.some((message) => message.is_read === true)).toBe(true);
  });

  it("walks two disjoint pages", async (ctx) => {
    const folder = await populatedFolder();
    const first = await getMessages({ folder_ids: [folder.id], limit: 2 });
    if (!first.next_cursor) {
      ctx.skip();
      return;
    }
    const second = await getMessages({
      folder_ids: [folder.id],
      limit: 2,
      cursor: first.next_cursor,
    });

    const firstKeys = new Set(
      first.sources.flatMap((source) =>
        (source.messages ?? []).map(
          (message) => `${source.source_id}:${message.id}`,
        ),
      ),
    );
    const secondKeys = second.sources.flatMap((source) =>
      (source.messages ?? []).map(
        (message) => `${source.source_id}:${message.id}`,
      ),
    );
    expect(
      secondKeys.length,
      "a next_cursor was issued but the page it resumes is empty",
    ).toBeGreaterThan(0);
    for (const key of secondKeys) expect(firstKeys.has(key)).toBe(false);
  });

  it("reads one message with surrounding context", async () => {
    const folder = await populatedFolder();
    const page = await getMessages({ folder_ids: [folder.id], limit: 5 });
    const source = page.sources.find(
      (candidate) => (candidate.messages?.length ?? 0) > 2,
    );
    expect(
      source,
      "no source returned three messages; pick a busier folder",
    ).toBeTruthy();

    const target = source!.messages![1]!;
    const detail = await getMessage({
      source_id: source!.source_id,
      message_id: target.id,
      context_before: 2,
      context_after: 1,
    });
    expect(detail.message.id).toBe(target.id);
    expect(detail.source_title).toBe(source!.title);
    expect(detail.context_before.length).toBeGreaterThan(0);
    const before = detail.context_before.map((message) => message.id);
    expect([...before].sort((a, b) => a - b)).toEqual(before);
    for (const message of detail.context_before) {
      expect(message.id).toBeLessThan(target.id);
    }
  });

  it("summarizes unread state by source and by folder", async (ctx) => {
    const bySource = await getUnreadSummary({});
    const byFolder = await getUnreadSummary({ group_by: "folder" });

    // total_unread is a sum of positive counts, so >= 0 is a tautology and
    // would let this whole test pass having asserted nothing. Guard on the
    // list the loop below actually iterates.
    expect(
      bySource.groups.length,
      "the account has nothing unread; read something in before running the live suite",
    ).toBeGreaterThan(0);
    expect(bySource.total_unread).toBeGreaterThan(0);
    for (const group of bySource.groups) {
      expect(group.source_id).toBeTruthy();
      expect(group.unread_count).toBeGreaterThan(0);
    }

    // Unread sources can legitimately all sit outside every folder, which
    // leaves nothing for the folder loop to check. Skip visibly rather than
    // pass with zero assertions.
    if (byFolder.groups.length === 0) {
      ctx.skip();
      return;
    }
    for (const group of byFolder.groups) {
      expect(group.folder_id).toBeTruthy();
      expect(group.read_inbox_max_id).toBeUndefined();
    }
  });

  it("advances the read pointer and the summary reflects it", async (ctx) => {
    const before = await getUnreadSummary({});
    const target = before.groups[0];
    if (!target) {
      ctx.skip();
      return;
    }

    const result = await markRead({ source_ids: [target.source_id!] });
    expect(result.failures).toEqual([]);
    expect(result.results[0]!.read_inbox_max_id).toBeGreaterThanOrEqual(
      target.read_inbox_max_id!,
    );

    const after = await getUnreadSummary({});
    const still = after.groups.find(
      (group) => group.source_id === target.source_id,
    );
    expect(still?.unread_count ?? 0).toBeLessThan(target.unread_count);
  });
});
