import { afterEach, describe, expect, it } from "vitest";
import { isFanout, prepareSearch, searchMessages } from "@/telegram/search";
import {
  __resetClientForTests,
  __setClientFactoryForTests,
} from "@/telegram/client";
import { __resetPeerCacheForTests } from "@/telegram/peer-resolve";
import { decodeSearchGlobalCursor } from "@/pagination";
import { GramScopeError } from "@/errors/taxonomy";

const A = "-1001111111111";

function hit(id: number, date: number, channelId: bigint) {
  return {
    className: "Message",
    id,
    date,
    message: `hit ${id}`,
    peerId: { className: "PeerChannel", channelId },
  };
}

function dialogs() {
  return [
    {
      id: A,
      title: "Alpha",
      entity: { className: "Channel", id: 1111111111n, title: "Alpha" },
      dialog: { readInboxMaxId: 400 },
      unreadCount: 0,
      date: 1,
      message: { id: 500 },
    },
  ];
}

type Sent = { className: string; params: Record<string, unknown> };

function install(reply: unknown) {
  const sent: Sent[] = [];
  __setClientFactoryForTests(async () => ({
    connected: true,
    connect: async () => true,
    getDialogs: async () => dialogs(),
    getEntity: async (target: string) => ({
      className: "Channel",
      id: 1111111111n,
      target,
    }),
    getMessages: async () => [],
    invoke: async (request: unknown) => {
      const r = request as { className: string } & Record<string, unknown>;
      sent.push({ className: r.className, params: { ...r } });
      return reply;
    },
  }));
  return sent;
}

const slice = (messages: unknown[], extra: Record<string, unknown> = {}) => ({
  className: "messages.MessagesSlice",
  count: 4820,
  nextRate: 1_700_000_000,
  messages,
  chats: [{ className: "Channel", id: 1111111111n, title: "Alpha" }],
  users: [],
  ...extra,
});

afterEach(() => {
  __setClientFactoryForTests(undefined);
  __resetClientForTests();
  __resetPeerCacheForTests();
});

describe("mode selection", () => {
  it("is global with no source selection and fan-out with one", () => {
    expect(isFanout({ query: "x", limit: 10 })).toBe(false);
    expect(isFanout({ query: "x", limit: 10, source_ids: [A] })).toBe(true);
    expect(isFanout({ query: "x", limit: 10, folder_ids: ["2"] })).toBe(true);
    expect(isFanout({ query: "x", limit: 10, source_ids: [] })).toBe(false);
  });
});

describe("prepareSearch", () => {
  it("rejects an empty query", () => {
    expect(() => prepareSearch({ query: "   ", limit: 10 })).toThrow(
      GramScopeError,
    );
  });

  it("rejects exclude_source_ids without a source selection", () => {
    try {
      prepareSearch({ query: "x", limit: 10, exclude_source_ids: [A] });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as GramScopeError).code).toBe("INVALID_INPUT");
      expect((err as GramScopeError).message).toMatch(/source_ids|folder_ids/);
    }
  });

  it("rejects a reversed date range", () => {
    try {
      prepareSearch({
        query: "x",
        limit: 10,
        from: "2026-01-02T00:00:00Z",
        to: "2026-01-01T00:00:00Z",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as GramScopeError).code).toBe("INVALID_DATE_RANGE");
    }
  });

  it("fingerprints the query and every filter", () => {
    const base = prepareSearch({ query: "x", limit: 10 }).fingerprint;
    expect(prepareSearch({ query: "x", limit: 50 }).fingerprint).toBe(base);
    expect(prepareSearch({ query: "y", limit: 10 }).fingerprint).not.toBe(base);
    expect(
      prepareSearch({ query: "x", limit: 10, from: "2026-01-01T00:00:00Z" })
        .fingerprint,
    ).not.toBe(base);
    expect(
      prepareSearch({ query: "x", limit: 10, media_type: "photo" }).fingerprint,
    ).not.toBe(base);
  });
});

describe("global search", () => {
  it("sends one searchGlobal and flattens its hits", async () => {
    const sent = install(
      slice([hit(9, 1_750_000_200, 1111111111n), hit(8, 1_750_000_100, 1111111111n)]),
    );
    const page = await searchMessages({ query: "ai", limit: 10 });

    expect(sent.map((s) => s.className)).toEqual(["messages.SearchGlobal"]);
    expect(sent[0]!.params.q).toBe("ai");
    expect(page.results.map((r) => r.id)).toEqual([9, 8]);
    expect(page.results[0]!.chat_id).toBe(A);
    expect(page.results[0]!.source_title).toBe("Alpha");
    expect(page.results[0]!.is_read).toBe(true);
    expect(page.total_matches).toBe(4820);
    expect(page.sources).toEqual([
      { source_id: A, title: "Alpha", hit_count: 2 },
    ]);
  });

  it("passes the date window to Telegram rather than filtering here", async () => {
    const sent = install(slice([]));
    await searchMessages({
      query: "ai",
      limit: 10,
      from: "2024-01-01T00:00:00Z",
      to: "2026-01-01T00:00:00Z",
    });
    expect(sent[0]!.params.minDate).toBe(1_704_067_200);
    expect(sent[0]!.params.maxDate).toBe(1_767_225_600);
  });

  it("issues a cursor carrying the server's rate and resumes with it", async () => {
    install(
      slice([hit(9, 1_750_000_200, 1111111111n), hit(8, 1_750_000_100, 1111111111n)]),
    );
    const first = await searchMessages({ query: "ai", limit: 2 });
    const cursor = decodeSearchGlobalCursor(first.next_cursor!);
    expect(cursor).toMatchObject({ rate: 1_700_000_000, peer: A, id: 8 });

    __resetClientForTests();
    const sent = install(slice([]));
    await searchMessages({ query: "ai", limit: 2, cursor: first.next_cursor! });
    expect(sent[0]!.params.offsetRate).toBe(1_700_000_000);
    expect(sent[0]!.params.offsetId).toBe(8);
  });

  it("stops paging when the page came back short", async () => {
    install(slice([hit(9, 1_750_000_200, 1111111111n)]));
    const page = await searchMessages({ query: "ai", limit: 10 });
    expect(page.next_cursor).toBeUndefined();
  });

  it("rejects a cursor whose query no longer matches", async () => {
    install(
      slice([hit(9, 1_750_000_200, 1111111111n), hit(8, 1_750_000_100, 1111111111n)]),
    );
    const first = await searchMessages({ query: "ai", limit: 2 });
    await expect(
      searchMessages({ query: "robots", limit: 2, cursor: first.next_cursor! }),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });

  it("keeps an oversized page under the response cap and resumes below it", async () => {
    const big = (id: number, date: number) => ({
      ...hit(id, date, 1111111111n),
      message: "x".repeat(20_000),
    });
    install(
      slice(
        Array.from({ length: 40 }, (_, n) => big(100 - n, 1_750_000_000 - n)),
      ),
    );
    const page = await searchMessages({ query: "ai", limit: 40 });
    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(
      256 * 1024,
    );
    expect(page.results.length).toBeLessThan(40);
    const last = page.results[page.results.length - 1]!;
    expect(decodeSearchGlobalCursor(page.next_cursor!).id).toBe(last.id);
  });
});
