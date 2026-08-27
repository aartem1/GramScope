import { afterEach, describe, expect, it } from "vitest";
import {
  getMessage,
  getMessages,
  MAX_NETWORK_RESOLUTIONS_PER_CALL,
  parseDateBound,
  renderPage,
  resolveSourceSet,
  type Fetched,
} from "@/telegram/messages";
import {
  __resetClientForTests,
  __setClientFactoryForTests,
  withTelegram,
  type TelegramLike,
} from "@/telegram/client";
import { __resetPeerCacheForTests } from "@/telegram/peer-resolve";
import { decodeMessageCursor, encodeMessageCursor } from "@/pagination";
import { GramScopeError } from "@/errors/taxonomy";
import { MAX_RESPONSE_BYTES } from "@/schemas/size";

const A = "-100111";
const B = "-100222";
const C = "-100333";

function entry(id: string, title: string) {
  return {
    source_id: id,
    title,
    unread_count: 0,
    read_inbox_max_id: 0,
    folder_ids: [] as string[],
  };
}

const index = {
  byId: new Map([
    [A, entry(A, "Alpha")],
    [B, entry(B, "Beta")],
    [C, entry(C, "Gamma")],
  ]),
  folders: [
    {
      id: "2",
      title: "AI",
      included_peer_ids: [A, B],
      excluded_peer_ids: [],
      order: 0,
    },
  ],
};

function message(id: number, text = "x") {
  return { id, chat_id: A, date: "2025-01-01T00:00:00.000Z", text };
}

function block(
  id: string,
  title: string,
  ids: number[],
  hasMore = false,
): Fetched {
  return {
    source_id: id,
    title,
    handle: id,
    startOffsetId: 0,
    slice: {
      messages: ids.map((n) => message(n)),
      hasMore,
      nextOffsetId: hasMore ? ids[ids.length - 1]! : 0,
    },
  };
}

afterEach(() => {
  __setClientFactoryForTests(undefined);
  __resetClientForTests();
  __resetPeerCacheForTests();
});

describe("parseDateBound", () => {
  it("converts ISO 8601 to unix seconds", () => {
    expect(parseDateBound("2025-01-01T00:00:00Z", "from")).toBe(1735689600);
  });

  it("rejects an unparseable date as INVALID_INPUT", () => {
    const error = (() => {
      try {
        parseDateBound("last tuesday", "from");
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect((error as GramScopeError).code).toBe("INVALID_INPUT");
  });
});

describe("resolveSourceSet", () => {
  it("unions explicit sources with folder members, exclusions untouched", () => {
    // Subtraction moved past resolution: an exclusion may name its target by
    // an alias, which only matches once both sides are canonical marked ids.
    // This pass therefore unions and de-duplicates raw names and nothing else.
    const set = resolveSourceSet(
      {
        source_ids: [C],
        folder_ids: ["2"],
        exclude_source_ids: [B],
        limit: 20,
      },
      index,
    );
    expect(set.map((s) => s.handle)).toEqual([C, A, B]);
    expect(set.every((s) => s.offsetId === 0)).toBe(true);
  });

  it("de-duplicates a source named twice", () => {
    const set = resolveSourceSet(
      { source_ids: [A], folder_ids: ["2"], limit: 20 },
      index,
    );
    expect(set.map((s) => s.handle)).toEqual([A, B]);
  });

  it("rejects an empty selection", () => {
    const error = (() => {
      try {
        resolveSourceSet({ limit: 20 }, index);
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect((error as GramScopeError).code).toBe("INVALID_INPUT");
  });

  it("rejects more unjoined names than one call may look up", () => {
    // The 25-source ceiling now counts canonical sources and so cannot be
    // applied before resolution. This guard bounds what resolution costs:
    // names the dialog index cannot answer, which are the ones that reach
    // the network.
    const over = MAX_NETWORK_RESOLUTIONS_PER_CALL + 1;
    const many = Array.from({ length: over }, (_, i) => `-100${i}`);
    const error = (() => {
      try {
        resolveSourceSet({ source_ids: many, limit: 20 }, index);
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect((error as GramScopeError).code).toBe("INVALID_INPUT");
    expect((error as GramScopeError).message).toContain(String(over));
    // The message must name the ceiling the caller is actually splitting
    // toward, not only the lookup budget it happened to trip.
    expect((error as GramScopeError).message).toContain("25");
  });

  it("does not charge held sources or their exclusions against that budget", () => {
    // A whole folder minus half of it was rejected once: every member is a
    // peer the account holds, so resolving them costs nothing.
    const many = Array.from({ length: 60 }, (_, i) => `-100${i}`);
    const wide = {
      byId: new Map(many.map((id) => [id, entry(id, id)])),
      folders: [
        {
          id: "9",
          title: "Wide",
          included_peer_ids: many,
          excluded_peer_ids: [],
          order: 0,
        },
      ],
    };
    const set = resolveSourceSet(
      { folder_ids: ["9"], exclude_source_ids: many.slice(0, 35), limit: 20 },
      wide,
    );
    expect(set).toHaveLength(60);
  });

  it("takes its source set from the cursor and ignores source_ids", () => {
    const set = resolveSourceSet(
      {
        source_ids: [C],
        limit: 20,
        cursor: encodeMessageCursor({
          sources: [{ handle: B, offsetId: 77 }],
        }),
      },
      index,
    );
    expect(set).toEqual([{ handle: B, offsetId: 77 }]);
  });

  it("applies the lookup budget to a cursor too", () => {
    // Catches returning decoded cursor sources without any bound at all: a
    // cursor is client-supplied and must not buy more resolutions than a
    // fresh selection can.
    const over = MAX_NETWORK_RESOLUTIONS_PER_CALL + 1;
    const error = (() => {
      try {
        resolveSourceSet(
          {
            limit: 20,
            cursor: encodeMessageCursor({
              sources: Array.from({ length: over }, (_, i) => ({
                handle: `-100${i}`,
                offsetId: i,
              })),
            }),
          },
          index,
        );
      } catch (e) {
        return e;
      }
      return undefined;
    })();

    expect((error as GramScopeError).code).toBe("INVALID_INPUT");
    expect((error as GramScopeError).message).toContain(String(over));
    expect((error as GramScopeError).message.toLowerCase()).toContain("split");
  });

  it("rejects a cursor carrying no sources", () => {
    // Catches accepting an empty decoded cursor as a valid effective set.
    const error = (() => {
      try {
        resolveSourceSet(
          {
            limit: 20,
            cursor: encodeMessageCursor({ sources: [] }),
          },
          index,
        );
      } catch (e) {
        return e;
      }
      return undefined;
    })();

    expect((error as GramScopeError).code).toBe("INVALID_INPUT");
  });
});

describe("renderPage", () => {
  it("groups by source in the requested order", () => {
    const page = renderPage([
      block(A, "Alpha", [3, 2, 1]),
      block(B, "Beta", [9, 8]),
    ]);
    expect(page.sources.map((s) => s.source_id)).toEqual([A, B]);
    expect(page.sources[0]!.messages!.map((m) => m.id)).toEqual([3, 2, 1]);
    expect(page.next_cursor).toBeUndefined();
  });

  it("distinguishes a source that matched nothing from one never reached", () => {
    const page = renderPage([block(A, "Alpha", []), block(B, "Beta", [1])]);
    expect(page.sources[0]!.messages).toEqual([]);
    expect(page.sources[0]!.has_more).toBe(false);
  });

  it("cursors a source that still has history", () => {
    const page = renderPage([block(A, "Alpha", [3, 2], true)]);
    expect(page.sources[0]!.has_more).toBe(true);
    expect(decodeMessageCursor(page.next_cursor!).sources).toEqual([
      { handle: A, offsetId: 2 },
    ]);
  });

  it("trims the first oversized source and omits every source after it", () => {
    // One message near the cap, so the second source cannot fit at all.
    const fat = "y".repeat(Math.floor(MAX_RESPONSE_BYTES / 2));
    const fetched: Fetched[] = [
      {
        source_id: A,
        title: "Alpha",
        handle: A,
        startOffsetId: 0,
        slice: {
          messages: [
            { id: 3, chat_id: A, date: "2025-01-01T00:00:00.000Z", text: fat },
            { id: 2, chat_id: A, date: "2025-01-01T00:00:00.000Z", text: fat },
            { id: 1, chat_id: A, date: "2025-01-01T00:00:00.000Z", text: fat },
          ],
          hasMore: false,
          nextOffsetId: 0,
        },
      },
      block(B, "Beta", [9, 8]),
    ];

    const page = renderPage(fetched);
    expect(page.sources.map((s) => s.source_id)).toEqual([A]);
    expect(page.sources[0]!.has_more).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(page.sources), "utf8"),
    ).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);

    const resumed = decodeMessageCursor(page.next_cursor!).sources;
    // Alpha resumes after its last served message; Beta resumes where it
    // started, because this page never served any of it.
    expect(resumed).toContainEqual({
      handle: A,
      offsetId: page.sources[0]!.messages!.at(-1)!.id,
    });
    expect(resumed).toContainEqual({ handle: B, offsetId: 0 });
  });

  it("counts the response envelope and cursor toward the 256 KB cap", () => {
    // Catches sizing only page.sources while returning a larger full result.
    const fat = "z".repeat(130_916);
    const page = renderPage([
      {
        source_id: A,
        title: "Alpha",
        handle: A,
        startOffsetId: 0,
        slice: {
          messages: [message(2, fat), message(1, fat)],
          hasMore: false,
          nextOffsetId: 0,
        },
      },
      block(B, "Beta", [9]),
    ]);

    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(
      MAX_RESPONSE_BYTES,
    );
    expect(page.sources[0]!.messages).toHaveLength(1);
    expect(decodeMessageCursor(page.next_cursor!).sources).toEqual([
      { handle: A, offsetId: 2 },
      { handle: B, offsetId: 0 },
    ]);
  });

  it("reports one indivisible oversized message without truncating its text", () => {
    // Catches fitToSizeCap forcing one oversized message into the response.
    const text = "q".repeat(MAX_RESPONSE_BYTES);
    const fetched: Fetched[] = [
      {
        source_id: A,
        title: "Alpha",
        handle: A,
        startOffsetId: 0,
        slice: {
          messages: [message(7, text), message(6, "older")],
          hasMore: false,
          nextOffsetId: 0,
        },
      },
      block(B, "Beta", [9]),
    ];

    const page = renderPage(fetched);

    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(
      MAX_RESPONSE_BYTES,
    );
    expect(page.sources[0]).toMatchObject({
      source_id: A,
      title: "Alpha",
      error: { code: "INTERNAL_ERROR" },
    });
    expect(page.sources[0]!.error!.message).toContain("7");
    expect(page.sources[0]!.messages).toBeUndefined();
    expect(fetched[0]!.slice!.messages[0]!.text).toBe(text);
    expect(decodeMessageCursor(page.next_cursor!).sources).toEqual([
      { handle: A, offsetId: 7 },
      { handle: B, offsetId: 0 },
    ]);
  });

  it("keeps a failing source visible and out of the cursor", () => {
    const page = renderPage([
      {
        source_id: A,
        title: "Alpha",
        handle: A,
        startOffsetId: 0,
        error: { code: "NOT_A_MEMBER", message: "gone" },
      },
      block(B, "Beta", [1]),
    ]);
    expect(page.sources[0]).toEqual({
      source_id: A,
      title: "Alpha",
      error: { code: "NOT_A_MEMBER", message: "gone" },
    });
    expect(page.sources[1]!.messages).toHaveLength(1);
    expect(page.next_cursor).toBeUndefined();
  });
});

describe("getMessages", () => {
  const dialogs = [
    {
      id: { value: -100111n },
      title: "Alpha",
      unreadCount: 2,
      entity: { className: "Channel", id: { value: 111n }, username: "alpha" },
      dialog: { readInboxMaxId: 8 },
      message: { id: 10, date: 1735689600 },
    },
    {
      id: { value: -100222n },
      title: "Beta",
      unreadCount: 0,
      entity: { className: "Channel", id: { value: 222n } },
      dialog: { readInboxMaxId: 5 },
      message: { id: 5, date: 1735689600 },
    },
  ];

  function factory(
    byPeer: Record<string, unknown[]>,
    fail?: string,
    reads: string[] = [],
  ) {
    return async () => ({
      connected: true,
      connect: async () => true,
      invoke: async () => ({
        filters: [
          {
            id: 2,
            title: "AI",
            includePeers: [
              { channelId: { value: 111n } },
              { channelId: { value: 222n } },
            ],
            excludePeers: [],
          },
        ],
      }),
      getDialogs: async () => dialogs,
      getEntity: async () => ({}),
      getMessages: async (entity: string, params: Record<string, unknown>) => {
        reads.push(entity);
        if (entity === fail) throw new Error("CHANNEL_PRIVATE_STUB");
        const limit = typeof params.limit === "number" ? params.limit : 0;
        return (byPeer[entity] ?? []).slice(0, limit);
      },
    });
  }

  const post = (id: number, date = 1735689600) => ({
    className: "Message",
    id,
    date,
    message: `post ${id}`,
  });

  // Alpha's dialog entry carries a username, so resolveSource prefers it as
  // the handle passed to teleproto; Beta has none and keeps its marked id.
  const ALPHA_HANDLE = "alpha";

  it("fans out over a folder in one call and groups the result", async () => {
    __setClientFactoryForTests(
      factory({
        [ALPHA_HANDLE]: [post(10), post(9)],
        [B]: [post(5)],
      }),
    );
    const page = await getMessages({ folder_ids: ["2"], limit: 20 });
    expect(page.sources.map((s) => s.source_id)).toEqual([A, B]);
    expect(page.sources[0]!.title).toBe("Alpha");
    expect(page.sources[0]!.messages!.map((m) => m.id)).toEqual([10, 9]);
    expect(page.sources[0]!.messages![0]!.url).toBe("https://t.me/alpha/10");
  });

  it("excludes a folder member named by its t.me alias", async () => {
    const reads: string[] = [];
    __setClientFactoryForTests(factory({ [B]: [post(5)] }, undefined, reads));

    const page = await getMessages({
      folder_ids: ["2"],
      exclude_source_ids: ["https://t.me/alpha"],
      limit: 20,
    });

    expect(reads).toEqual([B]);
    expect(page.sources.map((source) => source.source_id)).toEqual([B]);
  });

  it("reads a source selected by id and username only once", async () => {
    const reads: string[] = [];
    __setClientFactoryForTests(
      factory({ [ALPHA_HANDLE]: [post(10)] }, undefined, reads),
    );

    const page = await getMessages({
      source_ids: [A, "@alpha"],
      limit: 20,
    });

    expect(reads).toEqual([ALPHA_HANDLE]);
    expect(page.sources).toHaveLength(1);
    expect(page.sources[0]!.messages).toHaveLength(1);
  });

  /**
   * Distinct names must resolve to distinct peers, or canonicalisation by
   * source_id would collapse an over-wide selection into one source and the
   * ceiling would pass vacuously.
   */
  function distinctPeers(reads: string[] = []) {
    return async () => ({
      connected: true,
      connect: async () => true,
      invoke: async () => ({ filters: [] }),
      getDialogs: async () => dialogs,
      getEntity: async (target: string) => ({
        className: "Channel",
        id: { value: BigInt(/^-100(\d+)$/.exec(target)![1]!) },
      }),
      getMessages: async (entity: string) => {
        reads.push(entity);
        return [];
      },
    });
  }

  it("rejects 26 canonical sources with count and split guidance", async () => {
    const reads: string[] = [];
    __setClientFactoryForTests(distinctPeers(reads));

    const error = await getMessages({
      source_ids: Array.from({ length: 26 }, (_, i) => `-100${i}`),
      limit: 20,
    }).then(
      () => undefined,
      (e) => e as GramScopeError,
    );

    expect(error?.code).toBe("INVALID_INPUT");
    expect(error?.message).toContain("26");
    expect(error?.message.toLowerCase()).toContain("split");
    // The ceiling must stop the call before it costs any reads.
    expect(reads).toEqual([]);
  });

  it("rejects a cursor carrying 26 canonical sources", async () => {
    __setClientFactoryForTests(distinctPeers());

    const error = await getMessages({
      limit: 20,
      cursor: encodeMessageCursor({
        sources: Array.from({ length: 26 }, (_, i) => ({
          handle: `-100${i}`,
          offsetId: i,
        })),
      }),
    }).then(
      () => undefined,
      (e) => e as GramScopeError,
    );

    expect(error?.code).toBe("INVALID_INPUT");
    expect(error?.message).toContain("26");
  });

  it("accepts 26 names that canonicalise to 25 sources", async () => {
    const reads: string[] = [];
    __setClientFactoryForTests(distinctPeers(reads));

    // The 26th name is an alias of the first: a t.me/c link carries the same
    // peer, so raw de-duplication cannot see it and only canonicalisation can.
    const names = Array.from({ length: 25 }, (_, i) => `-100${i}`);
    const page = await getMessages({
      source_ids: [...names, "https://t.me/c/0"],
      limit: 20,
    });

    expect(page.sources).toHaveLength(25);
    expect(reads).toHaveLength(25);
  });

  it("keeps the page when an exclusion cannot be resolved", async () => {
    // An exclusion that resolves nowhere cannot have matched anything, so it
    // must not take the whole page down with it. The realistic path is an
    // agent excluding an unjoined channel by the marked id it was handed,
    // which a cold instance answers CHANNEL_INVALID.
    __setClientFactoryForTests(factory({ [ALPHA_HANDLE]: [post(10)] }));

    const page = await getMessages({
      source_ids: [A],
      exclude_source_ids: ["-100999999999"],
      limit: 20,
    });

    expect(page.sources.map((source) => source.source_id)).toEqual([A]);
  });

  it("still subtracts an unresolvable exclusion written as a selected name", async () => {
    // Degrading to raw-key matching must not degrade to matching nothing.
    __setClientFactoryForTests(factory({ [ALPHA_HANDLE]: [post(10)] }));

    const page = await getMessages({
      source_ids: ["@ghost", A],
      exclude_source_ids: ["@Ghost"],
      limit: 20,
    });

    expect(page.sources.map((source) => source.source_id)).toEqual([A]);
  });

  it("collapses spellings of one unresolvable source into a single row", async () => {
    const reads: string[] = [];
    __setClientFactoryForTests(
      factory({ [ALPHA_HANDLE]: [post(10)] }, undefined, reads),
    );

    const page = await getMessages({
      source_ids: ["@ghost", "@Ghost", "https://t.me/ghost"],
      limit: 20,
    });

    expect(page.sources).toHaveLength(1);
    expect(page.sources[0]!.error?.code).toBe("CHANNEL_NOT_FOUND");
    expect(reads).toEqual([]);
  });

  /**
   * Resolves `@outside` over the network but refuses its marked id, which is
   * the real cold-instance asymmetry: a peer the account has not joined
   * answers to its username and not to a bare id.
   */
  function outsideFactory(lookups: string[] = []) {
    return async () => ({
      connected: true,
      connect: async () => true,
      invoke: async () => ({ filters: [] }),
      getDialogs: async () => dialogs,
      getEntity: async (target: string) => {
        lookups.push(target);
        if (target === "outside") {
          return {
            className: "Channel",
            id: { value: 555n },
            usernames: [
              { username: "outside", active: true, editable: true },
              { username: "outside_news", active: true },
            ],
          };
        }
        const error = new Error("CHANNEL_INVALID stub");
        (error as unknown as { errorMessage: string }).errorMessage =
          "CHANNEL_INVALID";
        throw error;
      },
      getMessages: async () => [],
    });
  }

  it("subtracts an unresolvable exclusion by the marked id of a source named otherwise", async () => {
    // The headline case of the degrade path: the channel was selected by
    // username, the exclusion names the same peer by an id no cold instance
    // resolves, and only the resolved source's own marked id can match it.
    __setClientFactoryForTests(outsideFactory());

    const page = await getMessages({
      source_ids: ["@outside", A],
      exclude_source_ids: ["-100555"],
      limit: 20,
    });

    expect(page.sources.map((source) => source.source_id)).toEqual([A]);
  });

  it("subtracts an unresolvable exclusion naming a secondary username", async () => {
    // A peer with collectible usernames answers to all of them, so the one it
    // travels by is not the only name that refers to it.
    __setClientFactoryForTests(outsideFactory());

    const page = await getMessages({
      source_ids: ["@outside", A],
      exclude_source_ids: ["@outside_news"],
      limit: 20,
    });

    expect(page.sources.map((source) => source.source_id)).toEqual([A]);
  });

  it("looks a source up once however many ways it is spelled", async () => {
    const lookups: string[] = [];
    __setClientFactoryForTests(outsideFactory(lookups));

    await getMessages({
      source_ids: ["@outside", "https://t.me/outside", "@Outside"],
      limit: 20,
    });

    expect(lookups).toEqual(["outside"]);
  });

  it("fails the call on a malformed exclusion rather than ignoring it", async () => {
    // Degrading is for a name Telegram cannot find, not for a name that never
    // named anything: spec §11 answers a bad source name with INVALID_INPUT,
    // and an exclusion silently dropped returns content the caller excluded.
    __setClientFactoryForTests(factory({ [ALPHA_HANDLE]: [post(10)] }));

    await expect(
      getMessages({
        folder_ids: ["2"],
        exclude_source_ids: ["Alpha News"],
        limit: 20,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("fails the call when an exclusion is rate limited", async () => {
    __setClientFactoryForTests(async () => ({
      connected: true,
      connect: async () => true,
      invoke: async () => ({ filters: [] }),
      getDialogs: async () => dialogs,
      getEntity: async () => {
        const error = new Error("flood stub");
        (error as unknown as { errorMessage: string }).errorMessage =
          "FLOOD_WAIT_30";
        throw error;
      },
      getMessages: async () => [],
    }));

    await expect(
      getMessages({
        source_ids: [A],
        exclude_source_ids: ["@throttled"],
        limit: 20,
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("subtracts an exclusion named by marked id", async () => {
    const reads: string[] = [];
    __setClientFactoryForTests(
      factory({ [ALPHA_HANDLE]: [post(10)] }, undefined, reads),
    );

    const page = await getMessages({
      folder_ids: ["2"],
      exclude_source_ids: [B],
      limit: 20,
    });

    expect(reads).toEqual([ALPHA_HANDLE]);
    expect(page.sources.map((source) => source.source_id)).toEqual([A]);
  });

  it("applies the read pointer when unread_only is set", async () => {
    __setClientFactoryForTests(
      factory({ [ALPHA_HANDLE]: [post(10), post(9), post(8), post(7)] }),
    );
    const page = await getMessages({
      source_ids: [A],
      unread_only: true,
      limit: 20,
    });
    expect(page.sources[0]!.messages!.map((m) => m.id)).toEqual([10, 9]);
  });

  it("reads a date window without consulting read state", async () => {
    // The owner's second query shape: a week's history, read or not.
    const week = 7 * 24 * 3600;
    __setClientFactoryForTests(
      factory({
        [ALPHA_HANDLE]: [post(10), post(9, 1735689600 - week - 1)],
      }),
    );
    const page = await getMessages({
      source_ids: [A],
      from: new Date((1735689600 - week) * 1000).toISOString(),
      limit: 20,
    });
    expect(page.sources[0]!.messages!.map((m) => m.id)).toEqual([10]);
  });

  it("rejects from after to", async () => {
    __setClientFactoryForTests(factory({}));
    await expect(
      getMessages({
        source_ids: [A],
        from: "2025-02-01T00:00:00Z",
        to: "2025-01-01T00:00:00Z",
        limit: 20,
      }),
    ).rejects.toMatchObject({ code: "INVALID_DATE_RANGE" });
  });

  it("degrades one dead source without failing the page", async () => {
    __setClientFactoryForTests(factory({ [B]: [post(5)] }, ALPHA_HANDLE));
    const page = await getMessages({ folder_ids: ["2"], limit: 20 });
    expect(page.sources[0]!.error).toBeTruthy();
    expect(page.sources[0]!.messages).toBeUndefined();
    expect(page.sources[1]!.messages).toHaveLength(1);
  });
});

describe("getMessage", () => {
  const dialogs = [
    {
      id: { value: -100111n },
      title: "Alpha",
      unreadCount: 0,
      entity: { className: "Channel", id: { value: 111n }, username: "alpha" },
      dialog: { readInboxMaxId: 100 },
      message: { id: 100, date: 1735689600 },
    },
  ];

  const post = (id: number) => ({
    className: "Message",
    id,
    date: 1735689600,
    message: `post ${id}`,
  });

  function factory(handler: (params: Record<string, unknown>) => unknown[]) {
    return async () => ({
      connected: true,
      connect: async () => true,
      invoke: async () => ({ filters: [] }),
      getDialogs: async () => dialogs,
      getEntity: async () => ({}),
      getMessages: async (_entity: string, params: Record<string, unknown>) =>
        handler(params),
    });
  }

  it("returns the target with the source title at the top level", async () => {
    __setClientFactoryForTests(
      factory((params) => (params.ids ? [post(50)] : [])),
    );
    const result = await getMessage({ source_id: A, message_id: 50 });
    expect(result.source_title).toBe("Alpha");
    expect(result.message.id).toBe(50);
    expect(result.context_before).toEqual([]);
    expect(result.context_after).toEqual([]);
    // The title is not repeated on the message itself.
    expect(JSON.stringify(result.message)).not.toContain("Alpha");
  });

  it("returns context in ascending date order", async () => {
    __setClientFactoryForTests(
      factory((params) => {
        if (params.ids) return [post(50)];
        if (params.addOffset === -2) return [post(52), post(51)];
        return [post(49), post(48)];
      }),
    );
    const result = await getMessage({
      source_id: A,
      message_id: 50,
      context_before: 2,
      context_after: 2,
    });
    expect(result.context_before.map((m) => m.id)).toEqual([48, 49]);
    expect(result.context_after.map((m) => m.id)).toEqual([51, 52]);
  });

  // teleproto returns a TotalList — an Array subclass carrying a `total`
  // property — and filter/map/sort preserve the subclass through
  // Symbol.species. Leaking it means the context arrays are not plain
  // arrays, which the live suite caught as a deep-equality failure against
  // values that looked identical.
  it("returns plain arrays, not the TL library's Array subclass", async () => {
    // Mirrors teleproto's real class (Helpers.js:448), which sets total in
    // its constructor. That matters: a subclass that only sets `total` on the
    // seed instance leaves species-derived arrays with `total: undefined`,
    // which toEqual ignores — so the deep-equality assertion below would pass
    // even with the fix reverted.
    class TotalList<T> extends Array<T> {
      total: number;
      constructor() {
        super();
        this.total = 0;
      }
    }
    const totalList = (items: unknown[]) => {
      const list = new TotalList<unknown>();
      list.push(...items);
      return list;
    };

    __setClientFactoryForTests(
      factory((params) => {
        if (params.ids) return totalList([post(50)]);
        if (params.addOffset === -2) return totalList([post(52), post(51)]);
        return totalList([post(49), post(48)]);
      }),
    );
    const result = await getMessage({
      source_id: A,
      message_id: 50,
      context_before: 2,
      context_after: 2,
    });

    expect(result.context_before.constructor).toBe(Array);
    expect(result.context_after.constructor).toBe(Array);
    expect(Object.hasOwn(result.context_before, "total")).toBe(false);
    expect(Object.hasOwn(result.context_after, "total")).toBe(false);
    // Deep equality against a plain array must hold, which is what fails
    // when a stray `total` rides along.
    expect(result.context_before).toEqual([...result.context_before]);
  });

  it("treats missing context as a shorter array, not an error", async () => {
    __setClientFactoryForTests(
      factory((params) => (params.ids ? [post(50)] : [])),
    );
    const result = await getMessage({
      source_id: A,
      message_id: 50,
      context_before: 5,
    });
    expect(result.context_before).toEqual([]);
  });

  it("reports an absent target as MESSAGE_NOT_FOUND", async () => {
    __setClientFactoryForTests(factory(() => [undefined as unknown as object]));
    await expect(
      getMessage({ source_id: A, message_id: 999 }),
    ).rejects.toMatchObject({ code: "MESSAGE_NOT_FOUND" });
  });

  it("reports MessageEmpty as MESSAGE_NOT_FOUND", async () => {
    __setClientFactoryForTests(
      factory(() => [{ className: "MessageEmpty", id: 999 }]),
    );
    await expect(
      getMessage({ source_id: A, message_id: 999 }),
    ).rejects.toMatchObject({ code: "MESSAGE_NOT_FOUND" });
  });

  it("rejects context bounds outside 0..20", async () => {
    __setClientFactoryForTests(factory(() => []));
    await expect(
      getMessage({ source_id: A, message_id: 1, context_after: 21 }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("sources outside the dialog index", () => {
  it("reads a channel named by username and keeps the username in the cursor", async () => {
    __setClientFactoryForTests(async () => ({
      connected: true,
      connect: async () => true,
      invoke: async () => ({ filters: [] }),
      getDialogs: async () => [],
      getEntity: async (target: string) => ({
        className: "Channel",
        id: 999n,
        title: "Outside",
        username: target.replace("@", ""),
      }),
      getMessages: async () => [
        { className: "Message", id: 5, date: 1_750_000_000, message: "hi" },
        { className: "Message", id: 4, date: 1_749_999_000, message: "ho" },
      ],
    }));

    const page = await getMessages({ source_ids: ["@outside"], limit: 2 });
    const block = page.sources[0]!;
    expect(block.source_id).toBe("-100999");
    expect(block.title).toBe("Outside");
    // No dialog entry means no read pointer, so read state is unknown rather
    // than guessed.
    expect(block.messages![0]!.is_read).toBeUndefined();
    expect(block.messages![0]!.url).toBe("https://t.me/outside/5");
    expect(decodeMessageCursor(page.next_cursor!).sources).toEqual([
      { handle: "outside", offsetId: 4 },
    ]);
  });

  it("turns an unresolvable source into one error block, not a failed page", async () => {
    __setClientFactoryForTests(async () => ({
      connected: true,
      connect: async () => true,
      invoke: async () => ({ filters: [] }),
      getDialogs: async () => [],
      getEntity: async () => {
        throw Object.assign(new Error("x"), {
          errorMessage: "USERNAME_NOT_OCCUPIED",
        });
      },
      getMessages: async () => [],
    }));

    const page = await getMessages({ source_ids: ["@nobodyhere"], limit: 2 });
    expect(page.sources).toEqual([
      {
        source_id: "@nobodyhere",
        title: "@nobodyhere",
        error: {
          code: "CHANNEL_NOT_FOUND",
          message: "Telegram error: USERNAME_NOT_OCCUPIED",
        },
      },
    ]);
  });

  it("reports a cold-instance marked id as CHANNEL_NOT_FOUND, not INTERNAL_ERROR", async () => {
    // What a fresh serverless instance really gets for a bare marked id of a
    // channel the account has not joined: teleproto catches the CHANNEL_INVALID
    // itself and rethrows a plain Error with no errorMessage.
    __setClientFactoryForTests(async () => ({
      connected: true,
      connect: async () => true,
      invoke: async () => ({ filters: [] }),
      getDialogs: async () => [],
      getEntity: async () => {
        throw new Error(
          `Could not find the input entity for ${JSON.stringify({ channelId: "999" })}.
         Please read https://docs.teleproto.dev/concepts/entities to find out more details.`,
        );
      },
      getMessages: async () => [],
    }));

    const page = await getMessages({ source_ids: ["-100999"], limit: 2 });
    expect(page.sources[0]!.error?.code).toBe("CHANNEL_NOT_FOUND");
  });

  it("keeps a classifiable resolution failure's own code", async () => {
    __setClientFactoryForTests(async () => ({
      connected: true,
      connect: async () => true,
      invoke: async () => ({ filters: [] }),
      getDialogs: async () => [],
      getEntity: async () => {
        throw Object.assign(new Error("x"), { errorMessage: "FLOOD_WAIT_30" });
      },
      getMessages: async () => [],
    }));

    const page = await getMessages({ source_ids: ["-100999"], limit: 2 });
    expect(page.sources[0]!.error?.code).toBe("RATE_LIMITED");
  });

  type ErrorHandler = (error: unknown) => void | Promise<void>;

  function unresolved(target: string): Error {
    return new Error(
      `Could not find the input entity for ${JSON.stringify({ target })}.\n` +
        "         Please read https://docs.teleproto.dev/concepts/entities to find out more details.",
    );
  }

  function rpcError(errorMessage: string): Error {
    return Object.assign(new Error(errorMessage), { errorMessage });
  }

  function swallowingFactory(original: unknown | undefined) {
    let onError: ErrorHandler = async () => undefined;
    const client = {
      connected: true,
      connect: async () => true,
      invoke: async () => ({ filters: [] }),
      getDialogs: async () => [],
      set onError(handler: ErrorHandler) {
        onError = handler;
      },
      getEntity: async (target: string) => {
        if (original !== undefined) await onError(original);
        throw unresolved(target);
      },
      getMessages: async () => [],
    } as TelegramLike;
    return { factory: async () => client, handler: () => onError };
  }

  it("keeps a CHANNEL_INVALID swallowed by teleproto as CHANNEL_NOT_FOUND", async () => {
    const fake = swallowingFactory(rpcError("CHANNEL_INVALID"));
    __setClientFactoryForTests(fake.factory);

    const page = await getMessages({ source_ids: ["-100999"], limit: 2 });
    expect(page.sources[0]!.error).toEqual({
      code: "CHANNEL_NOT_FOUND",
      message:
        "Telegram could not resolve that peer. A channel the account has not joined must be addressed by @username or t.me link; a bare id resolves only while the peer is already known to this instance.",
    });
  });

  it("keeps a FLOOD_WAIT swallowed by teleproto as RATE_LIMITED", async () => {
    const fake = swallowingFactory(rpcError("FLOOD_WAIT_30"));
    __setClientFactoryForTests(fake.factory);

    const page = await getMessages({ source_ids: ["-100999"], limit: 2 });
    expect(page.sources[0]!.error).toEqual({
      code: "RATE_LIMITED",
      message: "Telegram rate limit; retry after 30s",
    });
  });

  it("keeps an auth failure swallowed by teleproto as AUTH_REQUIRED", async () => {
    const fake = swallowingFactory(rpcError("AUTH_KEY_UNREGISTERED"));
    __setClientFactoryForTests(fake.factory);

    const page = await getMessages({ source_ids: ["-100999"], limit: 2 });
    expect(page.sources[0]!.error?.code).toBe("AUTH_REQUIRED");
  });

  it("keeps a generic transport failure swallowed by teleproto as INTERNAL_ERROR without exposing it", async () => {
    const fake = swallowingFactory(
      new Error("connect ECONNRESET session=DO_NOT_EXPOSE"),
    );
    __setClientFactoryForTests(fake.factory);

    const page = await getMessages({ source_ids: ["-100999"], limit: 2 });
    expect(page.sources[0]!.error).toEqual({
      code: "INTERNAL_ERROR",
      message: "Unexpected internal error",
    });
  });

  it("keeps concurrent swallowed failures isolated by resolution", async () => {
    let onError: ErrorHandler = async () => undefined;
    let releaseFlood!: () => void;
    let releaseAuth!: () => void;
    const floodCaptured = new Promise<void>((resolve) => {
      releaseFlood = resolve;
    });
    const authCaptured = new Promise<void>((resolve) => {
      releaseAuth = resolve;
    });
    const client = {
      connected: true,
      connect: async () => true,
      invoke: async () => ({ filters: [] }),
      getDialogs: async () => [],
      set onError(handler: ErrorHandler) {
        onError = handler;
      },
      getEntity: async (target: string) => {
        if (target === "flood") {
          await onError(rpcError("FLOOD_WAIT_9"));
          releaseFlood();
          await authCaptured;
        } else {
          await floodCaptured;
          await onError(rpcError("AUTH_KEY_UNREGISTERED"));
          releaseAuth();
        }
        throw unresolved(target);
      },
      getMessages: async () => [],
    } as TelegramLike;
    __setClientFactoryForTests(async () => client);

    const page = await getMessages({
      source_ids: ["@flood", "@auth"],
      limit: 2,
    });
    expect(page.sources.map((source) => source.error?.code)).toEqual([
      "RATE_LIMITED",
      "AUTH_REQUIRED",
    ]);
  });

  it("retains the narrow unresolved-entity fallback when no error was captured", async () => {
    const fake = swallowingFactory(undefined);
    __setClientFactoryForTests(fake.factory);

    const page = await getMessages({ source_ids: ["-100999"], limit: 2 });
    expect(page.sources[0]!.error?.code).toBe("CHANNEL_NOT_FOUND");
  });

  it("does not leak an onError call outside a resolution into the next one", async () => {
    const fake = swallowingFactory(undefined);
    __setClientFactoryForTests(fake.factory);
    await withTelegram(async () => undefined);
    await fake.handler()(rpcError("FLOOD_WAIT_45"));

    const page = await getMessages({ source_ids: ["-100999"], limit: 2 });
    expect(page.sources[0]!.error?.code).toBe("CHANNEL_NOT_FOUND");
  });

  it("accepts a t.me link in get_message", async () => {
    let seenEntity: string | undefined;
    __setClientFactoryForTests(async () => ({
      connected: true,
      connect: async () => true,
      invoke: async () => ({ filters: [] }),
      getDialogs: async () => [],
      getEntity: async () => ({
        className: "Channel",
        id: 999n,
        title: "Outside",
        username: "outside",
      }),
      getMessages: async (entity: string) => {
        seenEntity = entity;
        return [
          { className: "Message", id: 5, date: 1_750_000_000, message: "hi" },
        ];
      },
    }));

    const detail = await getMessage({
      source_id: "https://t.me/outside/5",
      message_id: 5,
    });
    expect(detail.source_id).toBe("-100999");
    expect(detail.source_title).toBe("Outside");
    expect(detail.message.id).toBe(5);
    // The resolved handle must reach teleproto, not the raw t.me link: a bare
    // "https://t.me/outside/5" string is not a valid MTProto entity.
    expect(seenEntity).toBe("outside");
  });
});
