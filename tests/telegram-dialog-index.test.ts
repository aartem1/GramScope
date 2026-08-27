import { afterEach, describe, expect, it } from "vitest";
import {
  fetchDialogIndex,
  folderMembers,
  toEntry,
} from "@/telegram/dialog-index";
import {
  __resetClientForTests,
  __setClientFactoryForTests,
} from "@/telegram/client";
import { GramScopeError } from "@/errors/taxonomy";

const AI_NEWS_ID = "-1001234567890";
const TECH_ID = "-1009876543210";

const aiNewsDialog = {
  id: { value: -1001234567890n },
  title: "AI News",
  unreadCount: 5,
  entity: {
    className: "Channel",
    id: { value: 1234567890n },
    username: "ainews",
  },
  dialog: { readInboxMaxId: 900 },
  message: { id: 905, date: 1735689600 },
};

const techDialog = {
  id: { value: -1009876543210n },
  title: "Tech",
  unreadCount: 0,
  entity: { className: "Channel", id: { value: 9876543210n } },
  dialog: { readInboxMaxId: 40 },
  message: { id: 40, date: 1735603200 },
};

const folders = [
  {
    id: "2",
    title: "AI",
    includePeers: [{ channelId: { value: 1234567890n } }],
    excludePeers: [],
  },
];

function fakeClient(dialogs: unknown[]) {
  return {
    connected: true,
    connect: async () => true,
    invoke: async () => ({ filters: folders }),
    getDialogs: async () => dialogs,
    getEntity: async () => ({}),
    getMessages: async () => [],
  };
}

afterEach(() => {
  __setClientFactoryForTests(undefined);
  __resetClientForTests();
});

describe("toEntry", () => {
  it("carries the pointer, the latest message and folder membership", () => {
    const entry = toEntry(aiNewsDialog, new Map([[AI_NEWS_ID, ["2"]]]));
    expect(entry).toEqual({
      source_id: AI_NEWS_ID,
      title: "AI News",
      username: "ainews",
      unread_count: 5,
      read_inbox_max_id: 900,
      latest_message_id: 905,
      latest_message_date: "2025-01-01T00:00:00.000Z",
      folder_ids: ["2"],
    });
  });

  it("defaults an absent unread count and pointer to zero", () => {
    const entry = toEntry(
      { id: { value: -100111n }, title: "X", entity: { className: "Channel", id: { value: 111n } } },
      new Map(),
    );
    expect(entry.unread_count).toBe(0);
    expect(entry.read_inbox_max_id).toBe(0);
    expect(entry.folder_ids).toEqual([]);
  });
});

describe("folderMembers", () => {
  const parsed = [
    {
      id: "2",
      title: "AI",
      included_peer_ids: [AI_NEWS_ID, TECH_ID],
      excluded_peer_ids: [TECH_ID],
      order: 0,
    },
  ];

  it("expands a folder to its included minus excluded peers", () => {
    expect(folderMembers(parsed, ["2"])).toEqual([AI_NEWS_ID]);
  });

  it("rejects an unknown folder id", () => {
    const error = (() => {
      try {
        folderMembers(parsed, ["99"]);
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(GramScopeError);
    expect((error as GramScopeError).code).toBe("INVALID_INPUT");
  });

  it("returns empty array when given no folder ids", () => {
    expect(folderMembers(parsed, [])).toEqual([]);
  });

  it("preserves order: folder order and peer order within each folder", () => {
    const folders = [
      {
        id: "1",
        title: "First",
        included_peer_ids: ["a", "b"],
        excluded_peer_ids: [],
        order: 0,
      },
      {
        id: "2",
        title: "Second",
        included_peer_ids: ["c", "d"],
        excluded_peer_ids: [],
        order: 1,
      },
    ];
    expect(folderMembers(folders, ["2", "1"])).toEqual(["c", "d", "a", "b"]);
  });
});

describe("fetchDialogIndex", () => {
  it("indexes every dialog by its marked id in one pass", async () => {
    __setClientFactoryForTests(async () =>
      fakeClient([aiNewsDialog, techDialog]),
    );
    const index = await fetchDialogIndex();
    expect([...index.byId.keys()].sort()).toEqual(
      [AI_NEWS_ID, TECH_ID].sort(),
    );
    expect(index.byId.get(AI_NEWS_ID)?.read_inbox_max_id).toBe(900);
    expect(index.folders.map((f) => f.id)).toEqual(["2"]);
  });

  it("calls getDialogs once, not once per source", async () => {
    let calls = 0;
    __setClientFactoryForTests(async () => ({
      ...fakeClient([aiNewsDialog, techDialog]),
      getDialogs: async () => {
        calls++;
        return [aiNewsDialog, techDialog];
      },
    }));
    await fetchDialogIndex();
    expect(calls).toBe(1);
  });

  it("excludes a dialog with no usable id from the index", async () => {
    __setClientFactoryForTests(async () =>
      fakeClient([
        { title: "No ID", entity: { className: "Channel" }, dialog: {} },
        aiNewsDialog,
      ]),
    );
    const index = await fetchDialogIndex();
    expect([...index.byId.keys()]).toEqual([AI_NEWS_ID]);
  });
});
