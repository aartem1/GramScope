import { afterEach, describe, expect, it } from "vitest";
import {
  getMessages,
  parseDateBound,
  renderPage,
  resolveSourceSet,
  type Fetched,
} from "@/telegram/messages";
import {
  __resetClientForTests,
  __setClientFactoryForTests,
} from "@/telegram/client";
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
  it("unions explicit sources with folder members and subtracts exclusions", () => {
    const set = resolveSourceSet(
      { source_ids: [C], folder_ids: ["2"], exclude_source_ids: [B], limit: 20 },
      index,
    );
    expect(set.map((s) => s.sourceId)).toEqual([C, A]);
    expect(set.every((s) => s.offsetId === 0)).toBe(true);
  });

  it("de-duplicates a source named twice", () => {
    const set = resolveSourceSet(
      { source_ids: [A], folder_ids: ["2"], limit: 20 },
      index,
    );
    expect(set.map((s) => s.sourceId)).toEqual([A, B]);
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

  it("rejects more than 25 sources by name, never by truncation", () => {
    const many = Array.from({ length: 26 }, (_, i) => `-100${i}`);
    const error = (() => {
      try {
        resolveSourceSet({ source_ids: many, limit: 20 }, index);
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect((error as GramScopeError).code).toBe("INVALID_INPUT");
    expect((error as GramScopeError).message).toContain("26");
  });

  it("takes its source set from the cursor and ignores source_ids", () => {
    const set = resolveSourceSet(
      {
        source_ids: [C],
        limit: 20,
        cursor: encodeMessageCursor({
          sources: [{ sourceId: B, offsetId: 77 }],
        }),
      },
      index,
    );
    expect(set).toEqual([{ sourceId: B, offsetId: 77 }]);
  });

  it("rejects a cursor carrying 26 sources with count and split guidance", () => {
    // Catches returning decoded cursor sources before the effective-set cap.
    const error = (() => {
      try {
        resolveSourceSet(
          {
            limit: 20,
            cursor: encodeMessageCursor({
              sources: Array.from({ length: 26 }, (_, i) => ({
                sourceId: `-100${i}`,
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
    expect((error as GramScopeError).message).toContain("26");
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
      { sourceId: A, offsetId: 2 },
    ]);
  });

  it("trims the first oversized source and omits every source after it", () => {
    // One message near the cap, so the second source cannot fit at all.
    const fat = "y".repeat(Math.floor(MAX_RESPONSE_BYTES / 2));
    const fetched: Fetched[] = [
      {
        source_id: A,
        title: "Alpha",
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
      sourceId: A,
      offsetId: page.sources[0]!.messages!.at(-1)!.id,
    });
    expect(resumed).toContainEqual({ sourceId: B, offsetId: 0 });
  });

  it("counts the response envelope and cursor toward the 256 KB cap", () => {
    // Catches sizing only page.sources while returning a larger full result.
    const fat = "z".repeat(130_916);
    const page = renderPage([
      {
        source_id: A,
        title: "Alpha",
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
      { sourceId: A, offsetId: 2 },
      { sourceId: B, offsetId: 0 },
    ]);
  });

  it("reports one indivisible oversized message without truncating its text", () => {
    // Catches fitToSizeCap forcing one oversized message into the response.
    const text = "q".repeat(MAX_RESPONSE_BYTES);
    const fetched: Fetched[] = [
      {
        source_id: A,
        title: "Alpha",
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
      { sourceId: A, offsetId: 7 },
      { sourceId: B, offsetId: 0 },
    ]);
  });

  it("keeps a failing source visible and out of the cursor", () => {
    const page = renderPage([
      { source_id: A, title: "Alpha", startOffsetId: 0, error: { code: "NOT_A_MEMBER", message: "gone" } },
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

  function factory(byPeer: Record<string, unknown[]>, fail?: string) {
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

  it("fans out over a folder in one call and groups the result", async () => {
    __setClientFactoryForTests(
      factory({
        [A]: [post(10), post(9)],
        [B]: [post(5)],
      }),
    );
    const page = await getMessages({ folder_ids: ["2"], limit: 20 });
    expect(page.sources.map((s) => s.source_id)).toEqual([A, B]);
    expect(page.sources[0]!.title).toBe("Alpha");
    expect(page.sources[0]!.messages!.map((m) => m.id)).toEqual([10, 9]);
    expect(page.sources[0]!.messages![0]!.url).toBe("https://t.me/alpha/10");
  });

  it("applies the read pointer when unread_only is set", async () => {
    __setClientFactoryForTests(
      factory({ [A]: [post(10), post(9), post(8), post(7)] }),
    );
    const page = await getMessages({ source_ids: [A], unread_only: true, limit: 20 });
    expect(page.sources[0]!.messages!.map((m) => m.id)).toEqual([10, 9]);
  });

  it("reads a date window without consulting read state", async () => {
    // The owner's second query shape: a week's history, read or not.
    const week = 7 * 24 * 3600;
    __setClientFactoryForTests(
      factory({
        [A]: [post(10), post(9, 1735689600 - week - 1)],
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
    __setClientFactoryForTests(factory({ [B]: [post(5)] }, A));
    const page = await getMessages({ folder_ids: ["2"], limit: 20 });
    expect(page.sources[0]!.error).toBeTruthy();
    expect(page.sources[0]!.messages).toBeUndefined();
    expect(page.sources[1]!.messages).toHaveLength(1);
  });
});
