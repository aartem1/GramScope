import { afterEach, describe, expect, it } from "vitest";
import { getPinnedMessages } from "@/telegram/pinned";
import {
  __resetClientForTests,
  __setClientFactoryForTests,
} from "@/telegram/client";
import { __resetPeerCacheForTests } from "@/telegram/peer-resolve";
import { decodePinnedCursor } from "@/pagination";
import { MAX_RESPONSE_BYTES } from "@/schemas/size";

const A = "-1001111111111";

function largeMessage(id: number, textBytes: number) {
  return {
    className: "Message",
    id,
    date: 1_750_000_100 + id,
    message: "x".repeat(textBytes),
  };
}

function install(reply: unknown) {
  const sent: Array<Record<string, unknown>> = [];
  __setClientFactoryForTests(async () => ({
    connected: true,
    connect: async () => true,
    getDialogs: async () => [
      {
        id: A,
        title: "Alpha",
        entity: { className: "Channel", id: 1111111111n, title: "Alpha" },
        dialog: { readInboxMaxId: 700 },
        unreadCount: 0,
        date: 1,
        message: { id: 900 },
      },
    ],
    // Echo the requested peer: without this every source resolves to the
    // same marked id and the cross-source cursor test passes for the wrong
    // reason.
    getEntity: async (target: string) => ({
      className: "Channel",
      id: BigInt(target.replace("-100", "")),
    }),
    getMessages: async () => [],
    invoke: async (request: unknown) => {
      sent.push({ ...(request as Record<string, unknown>) });
      return reply;
    },
  }));
  return sent;
}

afterEach(() => {
  __setClientFactoryForTests(undefined);
  __resetClientForTests();
  __resetPeerCacheForTests();
});

describe("getPinnedMessages", () => {
  it("asks Telegram for pinned messages only", async () => {
    const sent = install({
      className: "messages.MessagesSlice",
      count: 2,
      messages: [
        { className: "Message", id: 800, date: 1_750_000_100, message: "pinned" },
      ],
      chats: [],
      users: [],
    });
    const page = await getPinnedMessages({ source_id: A, limit: 20 });

    // Fetching the dialog index invokes messages.GetDialogFilters first, so
    // pick this tool's own request out of what the fake recorded.
    const search = sent.find((r) => r.className === "messages.Search")!;
    expect(search).toBeTruthy();
    expect(search.q).toBe("");
    expect((search.filter as { className: string }).className).toBe(
      "InputMessagesFilterPinned",
    );
    expect(page.source_id).toBe(A);
    expect(page.source_title).toBe("Alpha");
    expect(page.messages.map((m) => m.id)).toEqual([800]);
    expect(page.messages[0]!.is_read).toBe(false);
    expect(page.next_cursor).toBeUndefined();
  });

  it("returns an empty list when nothing is pinned", async () => {
    install({ className: "messages.Messages", messages: [], chats: [], users: [] });
    const page = await getPinnedMessages({ source_id: A, limit: 20 });
    expect(page.messages).toEqual([]);
    expect(page.next_cursor).toBeUndefined();
  });

  it("cursors below the oldest pinned message when the page filled up", async () => {
    install({
      className: "messages.MessagesSlice",
      count: 9,
      messages: [
        { className: "Message", id: 800, date: 1_750_000_200 },
        { className: "Message", id: 700, date: 1_750_000_100 },
      ],
      chats: [],
      users: [],
    });
    const page = await getPinnedMessages({ source_id: A, limit: 2 });
    expect(decodePinnedCursor(page.next_cursor!).offsetId).toBe(700);
  });

  it("keeps a cursor-bearing near-cap response within the size limit", async () => {
    // 200_000 + 61_840 bytes of text sits just under MAX_RESPONSE_BYTES
    // without a cursor, but crosses it once next_cursor is added — this is
    // exactly the gap where measuring the size cap on a candidate missing
    // next_cursor would let an oversized response through.
    install({
      className: "messages.MessagesSlice",
      count: 3,
      messages: [largeMessage(9, 200_000), largeMessage(8, 61_840)],
      chats: [],
      users: [],
    });

    const page = await getPinnedMessages({ source_id: A, limit: 2 });

    expect(page.next_cursor).toBeTruthy();
    expect(
      Buffer.byteLength(JSON.stringify(page), "utf8"),
    ).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
  });

  it("feeds a returned cursor into a second call and reaches the outgoing request", async () => {
    const sent = install({
      className: "messages.MessagesSlice",
      count: 9,
      messages: [
        { className: "Message", id: 800, date: 1_750_000_200 },
        { className: "Message", id: 700, date: 1_750_000_100 },
      ],
      chats: [],
      users: [],
    });
    const page1 = await getPinnedMessages({ source_id: A, limit: 2 });
    expect(page1.next_cursor).toBeTruthy();

    await getPinnedMessages({
      source_id: A,
      limit: 2,
      cursor: page1.next_cursor!,
    });

    const searches = sent.filter((r) => r.className === "messages.Search");
    expect(searches).toHaveLength(2);
    expect(searches[1]!.offsetId).toBe(700);
  });

  it("rejects a cursor issued for another source", async () => {
    install({
      className: "messages.MessagesSlice",
      count: 9,
      messages: [
        { className: "Message", id: 800, date: 1_750_000_200 },
        { className: "Message", id: 700, date: 1_750_000_100 },
      ],
      chats: [],
      users: [],
    });
    const page = await getPinnedMessages({ source_id: A, limit: 2 });
    await expect(
      getPinnedMessages({
        source_id: "-1009999999999",
        limit: 2,
        cursor: page.next_cursor!,
      }),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });
});
