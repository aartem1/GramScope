import { afterEach, describe, expect, it } from "vitest";
import {
  dialogType,
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

const channelDialog = {
  id: { value: 111n },
  title: "AI News",
  unreadCount: 5,
  isChannel: true,
  isGroup: false,
  isUser: false,
  entity: { className: "Channel", username: "ainews", participantsCount: 4200 },
  dialog: { readInboxMaxId: 900 },
};

describe("dialogType", () => {
  it("classifies a broadcast channel", () => {
    expect(dialogType(channelDialog)).toBe("channel");
  });

  it("classifies a group", () => {
    expect(
      dialogType({ ...channelDialog, isChannel: false, isGroup: true }),
    ).toBe("group");
  });

  it("classifies a private chat", () => {
    expect(
      dialogType({
        ...channelDialog,
        isChannel: false,
        isGroup: false,
        isUser: true,
      }),
    ).toBe("chat");
  });
});

describe("foldersByPeer", () => {
  it("inverts folder membership, honoring exclusions", () => {
    const index = foldersByPeer([
      {
        id: "2",
        title: "AI",
        included_peer_ids: ["111", "222"],
        excluded_peer_ids: ["222"],
        order: 0,
      },
      {
        id: "3",
        title: "Tech",
        included_peer_ids: ["111"],
        excluded_peer_ids: [],
        order: 1,
      },
    ]);
    expect(index.get("111")).toEqual(["2", "3"]);
    expect(index.get("222")).toBeUndefined();
  });
});

describe("mapDialog", () => {
  it("maps a channel to a source", () => {
    const source = mapDialog(channelDialog, new Map([["111", ["2"]]]));
    expect(source).toMatchObject({
      id: "111",
      title: "AI News",
      username: "ainews",
      type: "channel",
      unread_count: 5,
      subscriber_count: 4200,
      read_inbox_max_id: 900,
      folder_ids: ["2"],
    });
  });

  it("builds a t.me url from the username", () => {
    expect(mapDialog(channelDialog, new Map()).url).toBe("https://t.me/ainews");
  });

  it("omits url and username for a private channel", () => {
    const source = mapDialog(
      { ...channelDialog, entity: { className: "Channel" } },
      new Map(),
    );
    expect(source.username).toBeUndefined();
    expect(source.url).toBeUndefined();
  });

  it("omits folder_ids when the peer is in no folder", () => {
    expect(mapDialog(channelDialog, new Map()).folder_ids).toBeUndefined();
  });
});

describe("listDialogs cursor advance", () => {
  function dialogAt(id: number, date: number, unread: number) {
    return {
      id: { value: BigInt(id) },
      title: `Chat ${id}`,
      unreadCount: unread,
      isChannel: true,
      isGroup: false,
      isUser: false,
      date,
      message: { id: date },
      entity: { className: "Channel" },
      dialog: { readInboxMaxId: 0 },
    };
  }

  function install(dialogs: unknown[]) {
    __setClientFactoryForTests(async () => ({
      connected: true,
      connect: async () => true,
      invoke: async () => ({ filters: [] }),
      getDialogs: async () => dialogs,
      getEntity: async () => ({}),
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
    expect(first.sources.map((s) => s.id)).toEqual(["2", "3"]);
    expect(decodeCursor(first.next_cursor!).offsetDate).toBe(80);
  });

  it("omits the cursor when the batch is exhausted and nothing was trimmed", async () => {
    install([dialogAt(1, 100, 5)]);
    const page = await listDialogs({ limit: 50 });
    expect(page.next_cursor).toBeUndefined();
  });

  it("forwards the whole offset triple to getDialogs", async () => {
    // Telegram resumes from offset_date + offset_id + offset_peer. Dropping the
    // peer silently degrades pagination to date precision.
    const calls: Record<string, unknown>[] = [];
    __setClientFactoryForTests(async () => ({
      connected: true,
      connect: async () => true,
      invoke: async () => ({ filters: [] }),
      getDialogs: async (params: Record<string, unknown>) => {
        calls.push(params);
        return [];
      },
      getEntity: async () => ({}),
    }));
    await listDialogs({
      limit: 10,
      cursor: encodeCursor({ offsetDate: 100, offsetId: 5, offsetPeerId: "777" }),
    });
    expect(calls[0]).toMatchObject({
      offsetDate: 100,
      offsetId: 5,
      offsetPeer: "777",
    });
  });
});

describe("getChannel", () => {
  function installEntity(entity: Record<string, unknown>) {
    __setClientFactoryForTests(async () => ({
      connected: true,
      connect: async () => true,
      invoke: async () => ({ filters: [] }),
      getDialogs: async () => [],
      getEntity: async () => entity,
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
      id: { value: 111n },
      title: "AI News",
      username: "ainews",
    });
    expect((await getChannel({ url: "https://t.me/ainews" })).id).toBe("111");
    expect((await getChannel({ url: "https://t.me/s/ainews" })).id).toBe("111");
  });

  it("classifies a megagroup as a group, not a channel", async () => {
    installEntity({
      className: "Channel",
      id: { value: 222n },
      title: "Chat",
      megagroup: true,
    });
    expect((await getChannel({ id: "222" })).type).toBe("group");
  });
});
