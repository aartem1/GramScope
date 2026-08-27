import { afterEach, describe, expect, it } from "vitest";
import { isFanout, prepareSearch, searchMessages } from "@/telegram/search";
import {
  __resetClientForTests,
  __setClientFactoryForTests,
} from "@/telegram/client";
import { __resetPeerCacheForTests } from "@/telegram/peer-resolve";
import {
  decodeSearchGlobalCursor,
  decodeSearchSourcesCursor,
  encodeSearchSourcesCursor,
} from "@/pagination";
import { GramScopeError } from "@/errors/taxonomy";
import { MAX_RAW_SOURCE_NAMES_PER_CALL } from "@/telegram/source-selection";

const A = "-1001111111111";
const B = "-1002222222222";

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
      slice([
        hit(9, 1_750_000_200, 1111111111n),
        hit(8, 1_750_000_100, 1111111111n),
      ]),
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
      slice([
        hit(9, 1_750_000_200, 1111111111n),
        hit(8, 1_750_000_100, 1111111111n),
      ]),
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
      slice([
        hit(9, 1_750_000_200, 1111111111n),
        hit(8, 1_750_000_100, 1111111111n),
      ]),
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

function twoDialogs() {
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
    {
      id: B,
      title: "Beta",
      entity: { className: "Channel", id: 2222222222n, title: "Beta" },
      dialog: { readInboxMaxId: 0 },
      unreadCount: 0,
      date: 1,
      message: { id: 500 },
    },
  ];
}

/** Replies per peer, so a fan-out can be asserted source by source. */
function installFanout(
  replies: Record<string, unknown | (() => never)>,
  folders: unknown[] = [],
) {
  const sent: Sent[] = [];
  __setClientFactoryForTests(async () => ({
    connected: true,
    connect: async () => true,
    getDialogs: async () => twoDialogs(),
    // Distinct names must resolve to distinct peers, or canonicalisation by
    // source_id would collapse an over-wide selection into one source and the
    // fan-out ceiling would pass vacuously.
    getEntity: async (target: string) => ({
      className: "Channel",
      id:
        target === B
          ? 2222222222n
          : target === A
            ? 1111111111n
            : BigInt(/^-100(\d+)$/.exec(target)?.[1] ?? "1111111111"),
    }),
    getMessages: async () => [],
    invoke: async (request: unknown) => {
      const r = request as { className: string } & Record<string, unknown>;
      sent.push({ className: r.className, params: { ...r } });
      if (r.className === "messages.GetDialogFilters")
        return { filters: folders };
      const peer = String(r.peer);
      const reply = replies[peer];
      if (typeof reply === "function") return (reply as () => never)();
      return reply ?? slice([]);
    },
  }));
  return sent;
}

function installAliasedFanout(folders: unknown[] = []) {
  const sent: Sent[] = [];
  __setClientFactoryForTests(async () => ({
    connected: true,
    connect: async () => true,
    getDialogs: async () => [
      {
        ...twoDialogs()[0],
        entity: {
          className: "Channel",
          id: 1111111111n,
          title: "Alpha",
          username: "alpha",
        },
      },
      {
        ...twoDialogs()[1],
        entity: {
          className: "Channel",
          id: 2222222222n,
          title: "Beta",
          username: "beta",
        },
      },
    ],
    getEntity: async (target: string) => ({
      className: "Channel",
      id: target.toLowerCase().includes("beta") ? 2222222222n : 1111111111n,
      title: target.toLowerCase().includes("beta") ? "Beta" : "Alpha",
      username: target.toLowerCase().includes("beta") ? "beta" : "alpha",
    }),
    getMessages: async () => [],
    invoke: async (request: unknown) => {
      const r = request as { className: string } & Record<string, unknown>;
      sent.push({ className: r.className, params: { ...r } });
      if (r.className === "messages.GetDialogFilters")
        return { filters: folders };
      const peer = String(r.peer);
      return peer === "beta"
        ? slice([hit(4, 1_750_000_400, 2222222222n)])
        : slice([hit(9, 1_750_000_300, 1111111111n)]);
    },
  }));
  return sent;
}

describe("fan-out search", () => {
  it("searches each named source and merges the hits by date", async () => {
    const sent = installFanout({
      [A]: slice([hit(9, 1_750_000_300, 1111111111n)]),
      [B]: slice([hit(4, 1_750_000_400, 2222222222n)]),
    });
    const page = await searchMessages({
      query: "ai",
      source_ids: [A, B],
      limit: 10,
    });

    const searches = sent.filter((s) => s.className === "messages.Search");
    expect(searches).toHaveLength(2);
    expect(searches[0]!.params.q).toBe("ai");
    // Newest first across sources, not grouped by source.
    expect(page.results.map((r) => r.id)).toEqual([4, 9]);
    expect(page.results.map((r) => r.source_title)).toEqual(["Beta", "Alpha"]);
    // total_matches sums the per-source counts in this mode.
    expect(page.total_matches).toBe(9640);
  });

  it("lists a searched source that matched nothing", async () => {
    installFanout({
      [A]: slice([hit(9, 1_750_000_300, 1111111111n)]),
      [B]: slice([]),
    });
    const page = await searchMessages({
      query: "ai",
      source_ids: [A, B],
      limit: 10,
    });
    expect(page.sources).toEqual([
      { source_id: A, title: "Alpha", hit_count: 1 },
      { source_id: B, title: "Beta", hit_count: 0 },
    ]);
  });

  it("isolates one failing source instead of failing the page", async () => {
    installFanout({
      [A]: slice([hit(9, 1_750_000_300, 1111111111n)]),
      [B]: () => {
        throw Object.assign(new Error("boom"), {
          errorMessage: "CHANNEL_PRIVATE",
        });
      },
    });
    const page = await searchMessages({
      query: "ai",
      source_ids: [A, B],
      limit: 10,
    });
    expect(page.results.map((r) => r.id)).toEqual([9]);
    expect(page.sources[1]).toEqual({
      source_id: B,
      title: "Beta",
      hit_count: 0,
      error: {
        code: "PRIVATE_CHANNEL_NOT_ACCESSIBLE",
        message: "Telegram error: CHANNEL_PRIVATE",
      },
    });
  });

  it("cursors only the sources that still have more, and never a failed one", async () => {
    installFanout({
      // Alpha filled its page and only one of its two hits fits the merged
      // limit, so it resumes below the one that was served.
      [A]: slice([
        hit(9, 1_750_000_300, 1111111111n),
        hit(8, 1_750_000_200, 1111111111n),
      ]),
      // Beta came back short and its only hit was served: exhausted.
      [B]: slice([hit(4, 1_750_000_400, 2222222222n)]),
    });
    const page = await searchMessages({
      query: "ai",
      source_ids: [A, B],
      limit: 2,
    });
    expect(page.results.map((r) => r.id)).toEqual([4, 9]);
    const cursor = decodeSearchSourcesCursor(page.next_cursor!);
    expect(cursor.sources).toEqual([{ handle: A, offsetId: 9 }]);
  });

  it("drops an excluded source before spending a request on it", async () => {
    const sent = installFanout({
      [A]: slice([hit(9, 1_750_000_300, 1111111111n)]),
      [B]: slice([hit(4, 1_750_000_400, 2222222222n)]),
    });
    const page = await searchMessages({
      query: "ai",
      source_ids: [A, B],
      exclude_source_ids: [B],
      limit: 10,
    });
    expect(sent.filter((s) => s.className === "messages.Search")).toHaveLength(
      1,
    );
    expect(page.sources.map((s) => s.source_id)).toEqual([A]);
  });

  it("excludes a folder member named by username before searching", async () => {
    const sent = installAliasedFanout([
      {
        className: "DialogFilter",
        id: 2,
        title: "AI",
        includePeers: [
          { channelId: { value: 1111111111n } },
          { channelId: { value: 2222222222n } },
        ],
        excludePeers: [],
        pinnedPeers: [],
      },
    ]);

    const page = await searchMessages({
      query: "ai",
      folder_ids: ["2"],
      exclude_source_ids: ["@alpha"],
      limit: 10,
    });

    const searches = sent.filter(
      (item) => item.className === "messages.Search",
    );
    expect(searches).toHaveLength(1);
    expect(String(searches[0]!.params.peer)).toBe("beta");
    expect(page.sources.map((source) => source.source_id)).toEqual([B]);
  });

  it("searches a source selected by id and username only once", async () => {
    const sent = installAliasedFanout();

    const page = await searchMessages({
      query: "ai",
      source_ids: [A, "@alpha"],
      limit: 10,
    });

    expect(
      sent.filter((item) => item.className === "messages.Search"),
    ).toHaveLength(1);
    expect(page.results).toHaveLength(1);
    expect(page.sources).toEqual([
      { source_id: A, title: "Alpha", hit_count: 1 },
    ]);
    expect(page.total_matches).toBe(4820);
  });

  it("refuses a selection wider than the fan-out ceiling", async () => {
    installFanout({});
    await expect(
      searchMessages({
        query: "ai",
        source_ids: Array.from({ length: 26 }, (_, n) => `-100${n}`),
        limit: 10,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("counts exclusions toward the pre-resolution name limit", async () => {
    // The raw guard is what bounds resolutions, and an exclusion costs one
    // resolution just as a selected source does.
    const sent = installFanout({});
    await expect(
      searchMessages({
        query: "ai",
        source_ids: [A],
        exclude_source_ids: Array.from(
          { length: MAX_RAW_SOURCE_NAMES_PER_CALL },
          (_, n) => `-1009${n}`,
        ),
        limit: 10,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(sent.filter((item) => item.className === "messages.Search")).toEqual(
      [],
    );
  });

  it("refuses a folder selection that resolves to no sources", async () => {
    installFanout({}, [
      {
        className: "DialogFilter",
        id: 9,
        title: "Empty",
        includePeers: [],
        excludePeers: [],
        pinnedPeers: [],
      },
    ]);
    await expect(
      searchMessages({ query: "ai", folder_ids: ["9"], limit: 10 }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("feeds a returned cursor back and resumes only the surviving source", async () => {
    const sent = installFanout({
      // Alpha filled its page and only one of its two hits fits the merged
      // limit, so it resumes below the one that was served.
      [A]: slice([
        hit(9, 1_750_000_300, 1111111111n),
        hit(8, 1_750_000_200, 1111111111n),
      ]),
      // Beta came back short and its only hit was served: exhausted.
      [B]: slice([hit(4, 1_750_000_400, 2222222222n)]),
    });
    const first = await searchMessages({
      query: "ai",
      source_ids: [A, B],
      limit: 2,
    });
    expect(first.next_cursor).toBeDefined();

    sent.length = 0;
    await searchMessages({
      query: "ai",
      source_ids: [A, B],
      limit: 2,
      cursor: first.next_cursor!,
    });

    const searches = sent.filter((s) => s.className === "messages.Search");
    // Beta was exhausted on page one and dropped from the cursor: it must not
    // be requested again.
    expect(searches).toHaveLength(1);
    expect(searches[0]!.params.peer).toBe(A);
    expect(searches[0]!.params.offsetId).toBe(9);
  });

  it("rejects a cursor naming zero sources", async () => {
    installFanout({});
    const input = { query: "ai", source_ids: [A], limit: 10 };
    const { fingerprint } = prepareSearch(input);
    const cursor = encodeSearchSourcesCursor({ sources: [], fingerprint });
    await expect(searchMessages({ ...input, cursor })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("rejects a cursor naming more sources than the fan-out ceiling", async () => {
    installFanout({});
    const input = { query: "ai", source_ids: [A], limit: 10 };
    const { fingerprint } = prepareSearch(input);
    const cursor = encodeSearchSourcesCursor({
      sources: Array.from({ length: 26 }, (_, n) => ({
        handle: `-100${n}`,
        offsetId: 0,
      })),
      fingerprint,
    });
    await expect(searchMessages({ ...input, cursor })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("never returns an oversized complete response", async () => {
    installFanout({
      [A]: slice([
        {
          ...hit(9, 1_750_000_300, 1111111111n),
          message: "x".repeat(256 * 1024),
        },
      ]),
    });

    await expect(
      searchMessages({ query: "ai", source_ids: [A], limit: 1 }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });
});
