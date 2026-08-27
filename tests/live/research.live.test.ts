import { beforeAll, describe, expect, it } from "vitest";
import { searchMessages } from "@/telegram/search";
import { getThread } from "@/telegram/thread";
import { resolveTelegramUrl } from "@/telegram/resolve";
import { getPinnedMessages } from "@/telegram/pinned";
import { getMessages } from "@/telegram/messages";
import { fetchFolders } from "@/telegram/folders";
import { fetchDialogIndex } from "@/telegram/dialog-index";
import { __resetClientForTests } from "@/telegram/client";
import { __resetPeerCacheForTests } from "@/telegram/peer-resolve";

const enabled = process.env.GRAMSCOPE_LIVE === "1";
const suite = enabled ? describe : describe.skip;

/** A Russian stopword: something every Russian-language account has matched
 *  thousands of times, so the query is not a guess about this account. */
const QUERY = "не";

/** A large public channel the dedicated account is not subscribed to. If it
 *  turns out to be subscribed, the outside-source tests skip visibly rather
 *  than assert the wrong thing. */
const OUTSIDE = "exampleuser";

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

suite("Research against the real account", () => {
  beforeAll(() => {
    if (!process.env.TELEGRAM_SESSION) {
      throw new Error("TELEGRAM_SESSION is required for live tests");
    }
  });

  it("searches the whole account and walks two disjoint pages", async () => {
    const first = await searchMessages({ query: QUERY, limit: 10 });
    expect(
      first.results.length,
      `nothing matched "${QUERY}" account-wide; pick a query this account has actually seen`,
    ).toBeGreaterThan(0);
    expect(first.sources.length).toBeGreaterThan(0);
    for (const hit of first.results) {
      expect(hit.chat_id).toBeTruthy();
      expect(hit.source_title).toBeTruthy();
    }
    // Newest first, per spec §7.
    const dates = first.results.map((hit) => Date.parse(hit.date));
    expect([...dates].sort((a, b) => b - a)).toEqual(dates);

    expect(first.next_cursor, "a full first page issued no cursor").toBeTruthy();
    const second = await searchMessages({
      query: QUERY,
      limit: 10,
      cursor: first.next_cursor!,
    });
    expect(
      second.results.length,
      "a next_cursor was issued but the page it resumes is empty",
    ).toBeGreaterThan(0);

    const seen = new Set(
      first.results.map((hit) => `${hit.chat_id}:${hit.id}`),
    );
    for (const hit of second.results) {
      expect(seen.has(`${hit.chat_id}:${hit.id}`)).toBe(false);
    }
  });

  it("rejects a cursor replayed against a different query", async () => {
    const first = await searchMessages({ query: QUERY, limit: 10 });
    expect(first.next_cursor).toBeTruthy();
    await expect(
      searchMessages({
        query: `${QUERY} ${QUERY}`,
        limit: 10,
        cursor: first.next_cursor!,
      }),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });

  it("fans a search over a real folder and walks two disjoint pages", async () => {
    const folder = await populatedFolder();
    const first = await searchMessages({
      query: QUERY,
      folder_ids: [folder.id],
      limit: 10,
    });
    expect(
      first.sources.length,
      "the folder search reported no sources at all",
    ).toBeGreaterThan(1);
    expect(
      first.results.length,
      `nothing in folder ${folder.title} matched "${QUERY}"`,
    ).toBeGreaterThan(0);
    for (const source of first.sources) {
      expect(source.source_id).toBeTruthy();
      expect(source.title).toBeTruthy();
    }

    expect(
      first.next_cursor,
      "the populated folder search did not issue a cursor for its second page",
    ).toBeTruthy();
    const second = await searchMessages({
      query: QUERY,
      folder_ids: [folder.id],
      limit: 10,
      cursor: first.next_cursor!,
    });
    const seen = new Set(
      first.results.map((hit) => `${hit.chat_id}:${hit.id}`),
    );
    expect(
      second.results.length,
      "a next_cursor was issued but the page it resumes is empty",
    ).toBeGreaterThan(0);
    for (const hit of second.results) {
      expect(seen.has(`${hit.chat_id}:${hit.id}`)).toBe(false);
    }
  });

  it("reads a real comment thread across two pages", async (ctx) => {
    const index = await fetchDialogIndex();
    const channels = [...index.byId.values()].slice(0, 12);
    expect(channels.length, "the account holds no dialogs").toBeGreaterThan(0);

    // Find a post that actually has comments, by reading the counter the
    // reading tools already return rather than by guessing.
    let found: { source_id: string; post_id: number } | undefined;
    for (const entry of channels) {
      const page = await getMessages({
        source_ids: [entry.source_id],
        limit: 20,
      });
      const post = (page.sources[0]?.messages ?? []).find(
        (message) => (message.replies ?? 0) > 25,
      );
      if (post) {
        found = { source_id: entry.source_id, post_id: post.id };
        break;
      }
    }
    if (!found) {
      ctx.skip();
      return;
    }

    const first = await getThread({ ...found, limit: 20 });
    expect(first.post.id).toBe(found.post_id);
    expect(first.comment_count).toBeGreaterThan(0);
    expect(
      first.comments.length,
      "a post with comments returned none",
    ).toBeGreaterThan(0);
    // The account is not a member of the discussion group.
    for (const comment of first.comments) {
      expect(comment.is_read).toBeUndefined();
    }

    expect(first.next_cursor).toBeTruthy();
    const second = await getThread({
      ...found,
      limit: 20,
      cursor: first.next_cursor!,
    });
    const seen = new Set(first.comments.map((comment) => comment.id));
    expect(
      second.comments.length,
      "a next_cursor was issued but the page it resumes is empty",
    ).toBeGreaterThan(0);
    for (const comment of second.comments) {
      expect(seen.has(comment.id)).toBe(false);
    }
  });

  it("reports a channel with no linked discussion group", async (ctx) => {
    const index = await fetchDialogIndex();
    const candidates = [...index.byId.values()].slice(0, 12);
    expect(
      candidates.length,
      "the account holds no dialogs to scan for a channel without discussion",
    ).toBeGreaterThan(0);
    let target: { source_id: string; post_id: number } | undefined;
    for (const entry of candidates) {
      const page = await getMessages({
        source_ids: [entry.source_id],
        limit: 10,
      });
      const post = (page.sources[0]?.messages ?? []).find(
        (message) => message.replies === undefined,
      );
      if (post) {
        target = { source_id: entry.source_id, post_id: post.id };
        break;
      }
    }
    if (!target) {
      ctx.skip();
      return;
    }
    await expect(getThread({ ...target, limit: 5 })).rejects.toMatchObject({
      code: "NO_DISCUSSION_THREAD",
    });
  });

  it("resolves a link to a channel the account has not joined, then reads it", async (ctx) => {
    const resolved = await resolveTelegramUrl({
      url: `https://t.me/${OUTSIDE}`,
    });
    if (resolved.source?.joined !== false) {
      ctx.skip();
      return;
    }
    expect(resolved.kind).toBe("source");
    expect(resolved.source.username?.toLowerCase()).toBe(OUTSIDE);
    expect(resolved.source.source_id).toBeTruthy();

    const page = await getMessages({ source_ids: [`@${OUTSIDE}`], limit: 5 });
    const block = page.sources[0]!;
    expect(block.source_id).toBe(resolved.source.source_id);
    expect(
      block.messages?.length,
      "the resolved outside channel returned no messages",
    ).toBeGreaterThan(0);
    // No membership means no read pointer.
    for (const message of block.messages!) {
      expect(message.is_read).toBeUndefined();
    }
  });

  it("pins the asymmetry: an outside channel resolves by username, not by id, on a cold instance", async (ctx) => {
    const resolved = await resolveTelegramUrl({
      url: `https://t.me/${OUTSIDE}`,
    });
    const markedId = resolved.source?.source_id;
    if (resolved.source?.joined !== false || !markedId) {
      ctx.skip();
      return;
    }

    // A fresh serverless instance holds neither the entity cache nor the memo.
    __resetClientForTests();
    __resetPeerCacheForTests();
    const byId = await getMessages({ source_ids: [markedId], limit: 3 });
    expect(byId.sources[0]!.error?.code).toBe("CHANNEL_NOT_FOUND");

    __resetClientForTests();
    __resetPeerCacheForTests();
    const byName = await getMessages({ source_ids: [`@${OUTSIDE}`], limit: 3 });
    expect(byName.sources[0]!.error).toBeUndefined();
    expect(byName.sources[0]!.messages?.length).toBeGreaterThan(0);
  });

  it("searches inside an outside channel without joining it", async (ctx) => {
    const resolved = await resolveTelegramUrl({
      url: `https://t.me/${OUTSIDE}`,
    });
    if (resolved.source?.joined !== false) {
      ctx.skip();
      return;
    }
    const page = await searchMessages({
      query: "a",
      source_ids: [`@${OUTSIDE}`],
      limit: 5,
    });
    expect(page.sources).toHaveLength(1);
    expect(page.sources[0]!.error).toBeUndefined();
  });

  it("reads pinned messages of a real source", async (ctx) => {
    const index = await fetchDialogIndex();
    const entries = [...index.byId.values()].slice(0, 12);
    expect(entries.length, "the account holds no dialogs").toBeGreaterThan(0);

    for (const entry of entries) {
      const page = await getPinnedMessages({
        source_id: entry.source_id,
        limit: 10,
      });
      expect(page.source_id).toBe(entry.source_id);
      if (page.messages.length > 0) {
        for (const message of page.messages) {
          expect(message.chat_id).toBe(entry.source_id);
        }
        return;
      }
    }
    // Every sampled source really has nothing pinned: an empty success, not a
    // failure, but nothing was asserted about content.
    ctx.skip();
  });
});
