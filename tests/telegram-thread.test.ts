import { afterEach, describe, expect, it } from "vitest";
import { getThread } from "@/telegram/thread";
import {
  __resetClientForTests,
  __setClientFactoryForTests,
} from "@/telegram/client";
import { __resetPeerCacheForTests } from "@/telegram/peer-resolve";
import { decodeThreadCursor } from "@/pagination";
import { GramScopeError } from "@/errors/taxonomy";
import { MAX_RESPONSE_BYTES } from "@/schemas/size";

const CHANNEL = "-1001111111111";
const GROUP = "-1002222222222";

function post(overrides: Record<string, unknown> = {}) {
  return {
    className: "Message",
    id: 500,
    date: 1_750_000_000,
    message: "the post",
    ...overrides,
  };
}

function comment(id: number) {
  return {
    className: "Message",
    id,
    date: 1_750_000_100 + id,
    message: `comment ${id}`,
  };
}

function largeComment(id: number, textBytes: number) {
  return { ...comment(id), message: "x".repeat(textBytes) };
}

/** Stands in for the dialog index this tool fetches through fetchDialogIndex,
 * which reaches Telegram through the same faked client. */
function dialogs() {
  return [
    {
      id: CHANNEL,
      title: "Alpha",
      entity: { className: "Channel", id: 1111111111n, title: "Alpha" },
      dialog: { readInboxMaxId: 0 },
      unreadCount: 0,
      date: 1,
      message: { id: 500 },
    },
  ];
}

type Invoked = { className: string; params: Record<string, unknown> };

function install(options: {
  post?: Record<string, unknown>;
  replies?: unknown;
}) {
  const invoked: Invoked[] = [];
  __setClientFactoryForTests(async () => ({
    connected: true,
    connect: async () => true,
    getDialogs: async () => dialogs(),
    getEntity: async () => ({ className: "Channel", id: 1111111111n }),
    getMessages: async () => (options.post ? [options.post] : []),
    invoke: async (request: unknown) => {
      const r = request as { className: string } & Record<string, unknown>;
      invoked.push({ className: r.className, params: { ...r } });
      if (r.className === "messages.GetReplies") return options.replies;
      return {};
    },
  }));
  return invoked;
}

afterEach(() => {
  __setClientFactoryForTests(undefined);
  __resetClientForTests();
  __resetPeerCacheForTests();
});

describe("getThread", () => {
  it("refuses a channel with no linked discussion group", async () => {
    install({ post: post() });
    await expect(
      getThread({ source_id: CHANNEL, post_id: 500, limit: 20 }),
    ).rejects.toMatchObject({ code: "NO_DISCUSSION_THREAD" });
  });

  it("returns an empty thread, not an error, when nobody commented", async () => {
    const invoked = install({
      post: post({ replies: { replies: 0, channelId: 2222222222n } }),
    });
    const result = await getThread({
      source_id: CHANNEL,
      post_id: 500,
      limit: 20,
    });
    expect(result.comment_count).toBe(0);
    expect(result.comments).toEqual([]);
    expect(result.discussion_chat_id).toBe(GROUP);
    expect(result.next_cursor).toBeUndefined();
    // The pre-check answered it: no getReplies was ever sent.
    expect(invoked.filter((c) => c.className === "messages.GetReplies")).toEqual(
      [],
    );
  });

  it("returns the post as the thread root with its comments", async () => {
    install({
      post: post({ replies: { replies: 215, channelId: 2222222222n } }),
      replies: {
        className: "messages.ChannelMessages",
        count: 217,
        messages: [comment(9), comment(8)],
        chats: [],
        users: [],
      },
    });
    const result = await getThread({
      source_id: CHANNEL,
      post_id: 500,
      limit: 2,
    });

    expect(result.source_id).toBe(CHANNEL);
    expect(result.source_title).toBe("Alpha");
    expect(result.post.id).toBe(500);
    // getReplies' live count, not the post's own slightly stale counter.
    expect(result.comment_count).toBe(217);
    expect(result.comments.map((c) => c.id)).toEqual([9, 8]);
    // Comments live in the discussion group, and the account is not a member,
    // so they carry that chat_id and no read state.
    expect(result.comments[0]!.chat_id).toBe(GROUP);
    expect(result.comments[0]!.is_read).toBeUndefined();
  });

  it("issues a cursor that resumes below the oldest comment served", async () => {
    install({
      post: post({ replies: { replies: 215, channelId: 2222222222n } }),
      replies: {
        className: "messages.ChannelMessages",
        count: 217,
        messages: [comment(9), comment(8)],
        chats: [],
        users: [],
      },
    });
    const first = await getThread({
      source_id: CHANNEL,
      post_id: 500,
      limit: 2,
    });
    expect(first.next_cursor).toBeTruthy();
    expect(decodeThreadCursor(first.next_cursor!).offsetId).toBe(8);
  });

  it("keeps a cursor-bearing near-cap response within the size limit", async () => {
    install({
      post: post({ replies: { replies: 3, channelId: 2222222222n } }),
      replies: {
        className: "messages.ChannelMessages",
        count: 3,
        messages: [largeComment(9, 200_000), largeComment(8, 61_680)],
        chats: [],
        users: [],
      },
    });

    const result = await getThread({
      source_id: CHANNEL,
      post_id: 500,
      limit: 2,
    });
    const withoutCursor = { ...result };
    delete withoutCursor.next_cursor;

    expect(result.next_cursor).toBeTruthy();
    expect(Buffer.byteLength(JSON.stringify(withoutCursor), "utf8")).toBeLessThanOrEqual(
      MAX_RESPONSE_BYTES,
    );
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(
      MAX_RESPONSE_BYTES,
    );
    expect(decodeThreadCursor(result.next_cursor!).offsetId).toBe(9);
  });

  it("rejects a cursor issued for another post", async () => {
    install({
      post: post({ replies: { replies: 215, channelId: 2222222222n } }),
      replies: {
        className: "messages.ChannelMessages",
        count: 217,
        messages: [comment(9), comment(8)],
        chats: [],
        users: [],
      },
    });
    const first = await getThread({
      source_id: CHANNEL,
      post_id: 500,
      limit: 2,
    });
    await expect(
      getThread({
        source_id: CHANNEL,
        post_id: 501,
        limit: 2,
        cursor: first.next_cursor!,
      }),
    ).rejects.toBeInstanceOf(GramScopeError);
  });

  it("reports a missing post as MESSAGE_NOT_FOUND", async () => {
    install({});
    await expect(
      getThread({ source_id: CHANNEL, post_id: 500, limit: 20 }),
    ).rejects.toMatchObject({ code: "MESSAGE_NOT_FOUND" });
  });
});
