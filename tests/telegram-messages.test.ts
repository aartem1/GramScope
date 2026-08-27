import { afterEach, describe, expect, it } from "vitest";
import {
  getMessage,
  getMessages,
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
  it("unions explicit sources with folder members and subtracts exclusions", () => {
    const set = resolveSourceSet(
      { source_ids: [C], folder_ids: ["2"], exclude_source_ids: [B], limit: 20 },
      index,
    );
    expect(set.map((s) => s.handle)).toEqual([C, A]);
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
          sources: [{ handle: B, offsetId: 77 }],
        }),
      },
      index,
    );
    expect(set).toEqual([{ handle: B, offsetId: 77 }]);
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

  it("applies the read pointer when unread_only is set", async () => {
    __setClientFactoryForTests(
      factory({ [ALPHA_HANDLE]: [post(10), post(9), post(8), post(7)] }),
    );
    const page = await getMessages({ source_ids: [A], unread_only: true, limit: 20 });
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
    __setClientFactoryForTests(factory((params) => (params.ids ? [post(50)] : [])));
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
