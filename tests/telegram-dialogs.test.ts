import { afterEach, describe, expect, it } from "vitest";
import {
  foldersByPeer,
  getChannel,
  listDialogs,
  mapDialog,
} from "@/telegram/dialogs";
import {
  __resetClientForTests,
  __setClientFactoryForTests,
} from "@/telegram/client";
import { decodeCursor, encodeCursor } from "@/pagination";
import { GramScopeError } from "@/errors/taxonomy";

// Real ids, in both representations. A Dialog's `id` is teleproto's MARKED
// form; the entity inside it, and every InputPeer in a folder, carry the BARE
// form. The fixture below used to give a CHANNEL dialog `id: 111n`, which
// teleproto cannot produce, and that is precisely why the folder/dialog id
// mismatch went unnoticed.
const AI_NEWS_BARE = 1234567890n;
const AI_NEWS_ID = "-1001234567890";

const channelDialog = {
  id: { value: -1001234567890n },
  title: "AI News",
  unreadCount: 5,
  isChannel: true,
  isGroup: false,
  isUser: false,
  entity: {
    className: "Channel",
    id: { value: AI_NEWS_BARE },
    username: "ainews",
    participantsCount: 4200,
  },
  dialog: { readInboxMaxId: 900 },
};

/** invoke() fake that answers GetDialogFilters and GetFullChannel apart. */
function invoker(filters: unknown[], full?: unknown) {
  return async (request: unknown) => {
    const name = (request as { className?: string }).className ?? "";
    if (name.includes("GetFullChannel")) {
      if (full instanceof Error) throw full;
      return full ?? {};
    }
    return { filters };
  };
}

describe("foldersByPeer", () => {
  it("inverts folder membership, honoring exclusions", () => {
    const index = foldersByPeer([
      {
        id: "2",
        title: "AI",
        included_peer_ids: [AI_NEWS_ID, "-987654321"],
        excluded_peer_ids: ["-987654321"],
        order: 0,
      },
      {
        id: "3",
        title: "Tech",
        included_peer_ids: [AI_NEWS_ID],
        excluded_peer_ids: [],
        order: 1,
      },
    ]);
    expect(index.get(AI_NEWS_ID)).toEqual(["2", "3"]);
    expect(index.get("-987654321")).toBeUndefined();
  });
});

describe("mapDialog", () => {
  it("maps a channel to a source", () => {
    const source = mapDialog(channelDialog, new Map([[AI_NEWS_ID, ["2"]]]));
    expect(source).toMatchObject({
      id: AI_NEWS_ID,
      title: "AI News",
      username: "ainews",
      type: "channel",
      unread_count: 5,
      subscriber_count: 4200,
      read_inbox_max_id: 900,
      folder_ids: ["2"],
    });
  });

  it("emits the marked id, which is what folder peer lists are keyed on", () => {
    expect(mapDialog(channelDialog, new Map()).id).toBe(AI_NEWS_ID);
  });

  it("derives the marked id from the entity when the dialog has none", () => {
    const withoutId = { ...channelDialog, id: undefined };
    expect(mapDialog(withoutId, new Map()).id).toBe(AI_NEWS_ID);
  });

  it("builds a t.me url from the username", () => {
    expect(mapDialog(channelDialog, new Map()).url).toBe("https://t.me/ainews");
  });

  it("omits url and username for a private channel", () => {
    const source = mapDialog(
      {
        ...channelDialog,
        entity: { className: "Channel", id: { value: AI_NEWS_BARE } },
      },
      new Map(),
    );
    expect(source.username).toBeUndefined();
    expect(source.url).toBeUndefined();
  });

  it("classifies a megagroup dialog as a group", () => {
    const source = mapDialog(
      {
        ...channelDialog,
        isGroup: true,
        entity: {
          className: "Channel",
          megagroup: true,
          id: { value: AI_NEWS_BARE },
        },
      },
      new Map(),
    );
    expect(source.type).toBe("group");
  });

  it("classifies a user dialog as a chat", () => {
    const source = mapDialog(
      {
        id: { value: 555000111n },
        title: "Ada",
        isChannel: false,
        isGroup: false,
        isUser: true,
        entity: { className: "User", id: { value: 555000111n } },
      },
      new Map(),
    );
    expect(source.type).toBe("chat");
    expect(source.id).toBe("555000111");
  });

  it("omits folder_ids when the peer is in no folder", () => {
    expect(mapDialog(channelDialog, new Map()).folder_ids).toBeUndefined();
  });
});

describe("folder membership reaches a channel dialog", () => {
  // The regression guard for the two-representation bug: the folder comes back
  // holding a BARE channelId, the dialog comes back holding a MARKED id, and
  // these must still describe the same peer. When they did not, folder_ids was
  // silently never populated and folder_id filtering returned empty pages.
  const filters = [
    {
      className: "DialogFilter",
      id: 2,
      title: { className: "TextWithEntities", text: "AI", entities: [] },
      includePeers: [
        { className: "InputPeerChannel", channelId: { value: AI_NEWS_BARE } },
      ],
      excludePeers: [],
    },
  ];

  afterEach(() => {
    __resetClientForTests();
    __setClientFactoryForTests(undefined);
  });

  function install() {
    __setClientFactoryForTests(async () => ({
      connected: true,
      connect: async () => true,
      invoke: invoker(filters),
      getDialogs: async () => [{ ...channelDialog, date: 100, message: { id: 7 } }],
      getEntity: async () => channelDialog.entity,
      getMessages: async () => [],
    }));
  }

  it("populates folder_ids for a channel that is a folder member", async () => {
    install();
    const { sources } = await listDialogs({ limit: 10 });
    expect(sources[0]!.folder_ids).toEqual(["2"]);
  });

  // Same TL-boundary leak as getMessage's context arrays: teleproto returns a
  // TotalList (an Array subclass carrying `total`), and map/filter/slice
  // preserve the subclass through Symbol.species, so it rides all the way out
  // to `sources`.
  it("returns plain arrays, not the TL library's Array subclass", async () => {
    class TotalList<T> extends Array<T> {
      total?: number;
    }
    const list = new TotalList<unknown>();
    list.push({ ...channelDialog, date: 100, message: { id: 7 } });
    list.total = 999;

    __setClientFactoryForTests(async () => ({
      connected: true,
      connect: async () => true,
      invoke: invoker(filters),
      getDialogs: async () => list,
      getEntity: async () => channelDialog.entity,
      getMessages: async () => [],
    }));

    const { sources } = await listDialogs({ limit: 10 });
    expect(sources.constructor).toBe(Array);
    expect(Object.hasOwn(sources, "total")).toBe(false);
    expect(sources).toEqual([...sources]);
  });

  it("returns the channel when filtering by that folder", async () => {
    install();
    const { sources } = await listDialogs({ folder_id: "2", limit: 10 });
    expect(sources.map((s) => s.id)).toEqual([AI_NEWS_ID]);
  });

  it("gives get_channel the same id list_dialogs emitted", async () => {
    install();
    const listed = (await listDialogs({ limit: 10 })).sources[0]!;
    const detail = await getChannel({ id: listed.id });
    expect(detail.id).toBe(listed.id);
    expect(detail.folder_ids).toEqual(["2"]);
  });

  it("rejects an unknown folder id", async () => {
    install();
    await expect(listDialogs({ folder_id: "99", limit: 10 })).rejects.toThrow(
      GramScopeError,
    );
  });
});

describe("listDialogs cursor advance", () => {
  // messageId defaults to date for convenience, but the two are distinct
  // fields: pagination resumes on date AND message id, so a test about tying
  // dates must be able to vary them independently.
  function dialogAt(
    id: number,
    date: number,
    unread: number,
    messageId: number = date,
  ) {
    return {
      id: { value: BigInt(`-100${id}`) },
      title: `Chat ${id}`,
      unreadCount: unread,
      isChannel: true,
      isGroup: false,
      isUser: false,
      date,
      message: { id: messageId },
      entity: { className: "Channel", id: { value: BigInt(id) } },
      dialog: { readInboxMaxId: 0 },
    };
  }

  function install(dialogs: unknown[]) {
    __setClientFactoryForTests(async () => ({
      connected: true,
      connect: async () => true,
      invoke: invoker([]),
      getDialogs: async () => dialogs,
      getEntity: async () => ({}),
      getMessages: async () => [],
    }));
  }

  afterEach(() => {
    __resetClientForTests();
    __setClientFactoryForTests(undefined);
  });

  it("still returns a cursor when every row is filtered out", async () => {
    // All read, so unread_only removes everything. Without a cursor the caller
    // can never reach the unread dialogs further down the list.
    install([dialogAt(1, 100, 0), dialogAt(2, 90, 0), dialogAt(3, 80, 0)]);
    const page = await listDialogs({ limit: 2, unread_only: true });
    expect(page.sources).toEqual([]);
    expect(page.next_cursor).toBeTruthy();
  });

  it("derives the cursor from the raw batch, not the filtered length", async () => {
    // Row 1 is filtered out, so a cursor built from the filtered page length
    // would point at row 1 and re-serve row 2 forever.
    install([dialogAt(1, 100, 0), dialogAt(2, 90, 5), dialogAt(3, 80, 5)]);
    const first = await listDialogs({ limit: 2, unread_only: true });
    expect(first.sources.map((s) => s.id)).toEqual(["-1002", "-1003"]);
    expect(decodeCursor(first.next_cursor!).offsetDate).toBe(80);
  });

  it("omits the cursor when the batch is exhausted and nothing was trimmed", async () => {
    install([dialogAt(1, 100, 5)]);
    const page = await listDialogs({ limit: 50 });
    expect(page.next_cursor).toBeUndefined();
  });

  it("keeps both dialogs when their dates tie across a page boundary", async () => {
    // The cursor paginates on date AND message id. Equal dates are therefore
    // safe precisely because the message id still separates the rows — dialogs
    // 1 and 2 share a date but carry different message ids. (Rows tying on
    // BOTH is the limitation documented on DialogCursor, which needs
    // offset_peer to resolve and is left to the live suite.)
    const all = [
      dialogAt(1, 100, 5, 20),
      dialogAt(2, 100, 5, 19),
      dialogAt(3, 90, 5, 18),
    ];
    __setClientFactoryForTests(async () => ({
      connected: true,
      connect: async () => true,
      invoke: invoker([]),
      getDialogs: async (params: Record<string, unknown>) => {
        const afterId = params.offsetId as number | undefined;
        const rows = afterId
          ? all.filter((d) => (d.message.id as number) < afterId)
          : all;
        return rows.slice(0, params.limit as number);
      },
      getEntity: async () => ({}),
      getMessages: async () => [],
    }));

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const result = await listDialogs({ limit: 1, ...(cursor ? { cursor } : {}) });
      seen.push(...result.sources.map((s) => s.id));
      if (!result.next_cursor) break;
      cursor = result.next_cursor;
    }
    expect(seen).toEqual(["-1001", "-1002", "-1003"]);
  });

  it("does not re-serve the boundary dialog on the next page", async () => {
    // Telegram returns dialogs with date <= offset_date, INCLUSIVE, and the
    // offset_peer that would disambiguate the boundary cannot be rebuilt by a
    // stateless server. So the last dialog of a page comes back as the first
    // of the next one unless we drop it ourselves. Observed against the real
    // account: page 1 ended with -1005555555555 and page 2 began with it.
    const all = [
      dialogAt(1, 300, 5, 30),
      dialogAt(2, 200, 5, 20),
      dialogAt(3, 100, 5, 10),
    ];
    __setClientFactoryForTests(async () => ({
      connected: true,
      connect: async () => true,
      invoke: async () => ({ filters: [] }),
      getDialogs: async (params: Record<string, unknown>) => {
        const offsetDate = params.offsetDate as number | undefined;
        const rows =
          offsetDate === undefined
            ? all
            : all.filter((d) => d.date <= offsetDate);
        return rows.slice(0, params.limit as number);
      },
      getEntity: async () => ({}),
      getMessages: async () => [],
    }));

    const first = await listDialogs({ limit: 2 });
    expect(first.sources.map((s) => s.id)).toEqual(["-1001", "-1002"]);

    const second = await listDialogs({ limit: 2, cursor: first.next_cursor! });
    expect(second.sources.map((s) => s.id)).toEqual(["-1003"]);
  });

  it("drops every dialog that tied on the boundary timestamp", async () => {
    // Several dialogs can share the boundary date; all of the ones already
    // served must be dropped, not just the last.
    const all = [
      dialogAt(1, 200, 5, 30),
      dialogAt(2, 200, 5, 20),
      dialogAt(3, 200, 5, 10),
      dialogAt(4, 100, 5, 5),
    ];
    __setClientFactoryForTests(async () => ({
      connected: true,
      connect: async () => true,
      invoke: async () => ({ filters: [] }),
      getDialogs: async (params: Record<string, unknown>) => {
        const offsetDate = params.offsetDate as number | undefined;
        const rows =
          offsetDate === undefined
            ? all
            : all.filter((d) => d.date <= offsetDate);
        return rows.slice(0, params.limit as number);
      },
      getEntity: async () => ({}),
      getMessages: async () => [],
    }));

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 6; page += 1) {
      const result = await listDialogs({
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...result.sources.map((s) => s.id));
      if (!result.next_cursor) break;
      cursor = result.next_cursor;
    }
    expect(seen).toEqual(["-1001", "-1002", "-1003", "-1004"]);
  });

  it("forwards the cursor offsets to getDialogs", async () => {
    // The cursor must actually reach the query; a cursor that round-trips but
    // is never sent silently re-serves page one forever.
    const calls: Record<string, unknown>[] = [];
    __setClientFactoryForTests(async () => ({
      connected: true,
      connect: async () => true,
      invoke: invoker([]),
      getDialogs: async (params: Record<string, unknown>) => {
        calls.push(params);
        return [];
      },
      getEntity: async () => ({}),
      getMessages: async () => [],
    }));
    await listDialogs({
      limit: 10,
      cursor: encodeCursor({ offsetDate: 100, offsetId: 5, boundaryIds: [] }),
    });
    expect(calls[0]).toMatchObject({ offsetDate: 100, offsetId: 5 });
  });

  it("excludes pinned dialogs on a continuation page but not on the first", async () => {
    // Telegram returns pinned dialogs whatever the offset, so a stateless
    // resume that leaves excludePinned false serves a pinned dialog twice
    // once its top message falls behind the offset.
    const calls: Record<string, unknown>[] = [];
    __setClientFactoryForTests(async () => ({
      connected: true,
      connect: async () => true,
      invoke: invoker([]),
      getDialogs: async (params: Record<string, unknown>) => {
        calls.push(params);
        return [];
      },
      getEntity: async () => ({}),
      getMessages: async () => [],
    }));

    await listDialogs({ limit: 10 });
    await listDialogs({
      limit: 10,
      cursor: encodeCursor({ offsetDate: 100, offsetId: 5, boundaryIds: [] }),
    });

    expect(calls[0]).toMatchObject({ ignorePinned: false });
    expect(calls[1]).toMatchObject({ ignorePinned: true });
  });
});

describe("getChannel", () => {
  function installEntity(entity: Record<string, unknown>, full?: unknown) {
    __setClientFactoryForTests(async () => ({
      connected: true,
      connect: async () => true,
      invoke: invoker([], full),
      getDialogs: async () => [],
      getEntity: async () => entity,
      getMessages: async () => [],
    }));
  }

  afterEach(() => {
    __resetClientForTests();
    __setClientFactoryForTests(undefined);
  });

  it("rejects when no identifier is given", async () => {
    installEntity({});
    await expect(getChannel({})).rejects.toBeInstanceOf(GramScopeError);
  });

  it("rejects when more than one identifier is given", async () => {
    installEntity({});
    await expect(
      getChannel({ id: "1", username: "two" }),
    ).rejects.toBeInstanceOf(GramScopeError);
  });

  it("rejects a URL that is not a Telegram link", async () => {
    installEntity({});
    await expect(
      getChannel({ url: "https://example.com/nope" }),
    ).rejects.toBeInstanceOf(GramScopeError);
  });

  it("accepts both the plain and the /s/ t.me URL forms", async () => {
    installEntity({
      className: "Channel",
      id: { value: AI_NEWS_BARE },
      title: "AI News",
      username: "ainews",
    });
    expect((await getChannel({ url: "https://t.me/ainews" })).id).toBe(
      AI_NEWS_ID,
    );
    expect((await getChannel({ url: "https://t.me/s/ainews" })).id).toBe(
      AI_NEWS_ID,
    );
  });

  it("classifies a megagroup as a group, not a channel", async () => {
    installEntity({
      className: "Channel",
      id: { value: 222n },
      title: "Chat",
      megagroup: true,
    });
    expect((await getChannel({ id: "-100222" })).type).toBe("group");
  });

  it("fills description and linked_discussion_id from channels.getFullChannel", async () => {
    // Api.Channel has neither field, so without the full fetch get_channel
    // returned strictly less than its own output schema advertises.
    installEntity(
      {
        className: "Channel",
        id: { value: AI_NEWS_BARE },
        title: "AI News",
        username: "ainews",
      },
      {
        className: "messages.ChatFull",
        fullChat: {
          className: "ChannelFull",
          about: "Daily AI links",
          linkedChatId: { value: 2233445566n },
        },
      },
    );

    const source = await getChannel({ id: AI_NEWS_ID });
    expect(source.description).toBe("Daily AI links");
    expect(source.linked_discussion_id).toBe("-1002233445566");
  });

  it("still answers from the basic entity when the full fetch fails", async () => {
    installEntity(
      {
        className: "Channel",
        id: { value: AI_NEWS_BARE },
        title: "AI News",
        username: "ainews",
      },
      Object.assign(new Error("CHANNEL_PRIVATE"), {
        errorMessage: "CHANNEL_PRIVATE",
      }),
    );

    const source = await getChannel({ id: AI_NEWS_ID });
    expect(source.id).toBe(AI_NEWS_ID);
    expect(source.title).toBe("AI News");
    expect(source.description).toBeUndefined();
    expect(source.linked_discussion_id).toBeUndefined();
  });

  it("does not attempt a full fetch for a user", async () => {
    let fullFetches = 0;
    __setClientFactoryForTests(async () => ({
      connected: true,
      connect: async () => true,
      invoke: async (request: unknown) => {
        const name = (request as { className?: string }).className ?? "";
        if (name.includes("GetFullChannel")) fullFetches += 1;
        return { filters: [] };
      },
      getDialogs: async () => [],
      getEntity: async () => ({
        className: "User",
        id: { value: 555000111n },
        firstName: "Ada",
      }),
      getMessages: async () => [],
    }));

    const source = await getChannel({ id: "555000111" });
    expect(source).toMatchObject({
      id: "555000111",
      title: "Ada",
      type: "chat",
    });
    expect(fullFetches).toBe(0);
  });
});
