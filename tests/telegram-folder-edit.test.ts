import { afterEach, describe, expect, it } from "vitest";
import {
  createFolder,
  deleteFolder,
  renameFolder,
} from "@/telegram/folder-edit";
import {
  __resetClientForTests,
  __setClientFactoryForTests,
} from "@/telegram/client";

/**
 * A filter carrying fields TelegramFolder does not model. Every one of them is
 * what the round-trip rule exists to protect: emoticon, color, pinnedPeers and
 * the behaviour flags survive nothing that rebuilds a filter from our own
 * four-field projection.
 */
function richFilter() {
  return {
    className: "DialogFilter",
    id: 2,
    title: { className: "TextWithEntities", text: "AI", entities: [] },
    emoticon: "🤖",
    color: 3,
    contacts: false,
    nonContacts: false,
    groups: true,
    broadcasts: true,
    bots: false,
    excludeMuted: true,
    excludeRead: false,
    excludeArchived: true,
    pinnedPeers: [
      { className: "InputPeerChannel", channelId: { value: 777n } },
    ],
    includePeers: [
      { className: "InputPeerChannel", channelId: { value: 111n } },
    ],
    excludePeers: [],
  };
}

function chatlistFilter() {
  return {
    className: "DialogFilterChatlist",
    id: 3,
    title: { className: "TextWithEntities", text: "Shared", entities: [] },
    includePeers: [
      { className: "InputPeerChannel", channelId: { value: 222n } },
    ],
  };
}

/**
 * The fake applies the writes it receives to its own filter list rather than
 * returning a frozen one. Every action here re-reads after writing — `order` is
 * a position in the server's list, not a property of the filter, so it cannot
 * be computed from what was sent — and a fake that could not represent the
 * write would make the post-state assertions untestable rather than wrong.
 */
function factory(options: {
  sent: unknown[];
  filters?: unknown[];
  entities?: Record<string, Record<string, unknown>>;
}) {
  const filters: Record<string, unknown>[] = (options.filters ?? [
    { className: "DialogFilterDefault" },
    richFilter(),
  ]) as Record<string, unknown>[];

  return async () => ({
    connected: true,
    connect: async () => true,
    invoke: async (request: unknown) => {
      options.sent.push(request);
      const r = request as Record<string, unknown>;
      const className = r.className as string | undefined;

      if (className === "messages.GetDialogFilters") {
        return { className: "messages.DialogFilters", filters };
      }

      if (className === "messages.UpdateDialogFilter") {
        const id = Number(r.id);
        const at = filters.findIndex((f) => Number(f.id) === id);
        if (r.filter === undefined) {
          if (at >= 0) filters.splice(at, 1);
        } else if (at >= 0) {
          filters[at] = r.filter as Record<string, unknown>;
        } else {
          filters.push(r.filter as Record<string, unknown>);
        }
        return true;
      }

      if (className === "messages.UpdateDialogFiltersOrder") {
        const order = (r.order as number[]) ?? [];
        filters.sort(
          (a, b) => order.indexOf(Number(a.id)) - order.indexOf(Number(b.id)),
        );
        return true;
      }

      return true;
    },
    getDialogs: async () => [],
    getEntity: async (name: string) =>
      options.entities?.[name] ?? {
        className: "Channel",
        id: { value: 999n },
        accessHash: { value: 7n },
      },
    getMessages: async () => [],
  });
}

function lastUpdate(sent: unknown[]): Record<string, unknown> {
  const update = sent
    .filter(
      (r) =>
        (r as { className?: string }).className ===
        "messages.UpdateDialogFilter",
    )
    .at(-1);
  expect(update, "no messages.UpdateDialogFilter was sent").toBeTruthy();
  return update as Record<string, unknown>;
}

afterEach(() => {
  __setClientFactoryForTests(undefined);
  __resetClientForTests();
});

describe("the folder round-trip rule", () => {
  it("preserves every unmodelled field through a rename", async () => {
    // The test that would have caught the naive implementation: rebuilding a
    // DialogFilter from TelegramFolder discards eleven of its fifteen fields.
    const sent: unknown[] = [];
    __setClientFactoryForTests(factory({ sent }));
    await renameFolder({ folder_id: "2", title: "Research" });

    const filter = lastUpdate(sent).filter as Record<string, unknown>;
    expect(filter.emoticon).toBe("🤖");
    expect(filter.color).toBe(3);
    expect(filter.excludeMuted).toBe(true);
    expect(filter.excludeArchived).toBe(true);
    expect(filter.groups).toBe(true);
    expect(filter.broadcasts).toBe(true);
    expect(filter.pinnedPeers).toHaveLength(1);
    expect(filter.includePeers).toHaveLength(1);
  });

  it("changes the title and nothing else", async () => {
    const sent: unknown[] = [];
    __setClientFactoryForTests(factory({ sent }));
    await renameFolder({ folder_id: "2", title: "Research" });

    const filter = lastUpdate(sent).filter as { title: unknown };
    const title = filter.title as { text?: string } | string;
    expect(typeof title === "string" ? title : title.text).toBe("Research");
  });

  it("refuses a shareable folder instead of converting it", async () => {
    // Writing a DialogFilterChatlist back as a DialogFilter would convert the
    // folder and destroy it: the chatlist constructor has no excludePeers and
    // no behaviour flags.
    const sent: unknown[] = [];
    __setClientFactoryForTests(
      factory({ sent, filters: [chatlistFilter()] }),
    );
    await expect(
      renameFolder({ folder_id: "3", title: "Nope" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(
      sent.some(
        (r) =>
          (r as { className?: string }).className ===
          "messages.UpdateDialogFilter",
      ),
    ).toBe(false);
  });

  it("rejects an unknown folder id", async () => {
    __setClientFactoryForTests(factory({ sent: [] }));
    await expect(
      renameFolder({ folder_id: "99", title: "Nope" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("createFolder", () => {
  it("picks the lowest free id at or above 2", async () => {
    // 0 is All chats and 1 is the archive; both are reserved by Telegram.
    const sent: unknown[] = [];
    __setClientFactoryForTests(
      factory({
        sent,
        filters: [
          { className: "DialogFilterDefault" },
          richFilter(),
          { ...richFilter(), id: 4 },
        ],
      }),
    );
    await createFolder({ title: "New" });
    expect(lastUpdate(sent).id).toBe(3);
  });

  it("reports the folder limit before calling Telegram", async () => {
    const sent: unknown[] = [];
    const many = Array.from({ length: 10 }, (_, i) => ({
      ...richFilter(),
      id: i + 2,
    }));
    __setClientFactoryForTests(factory({ sent, filters: many }));
    await expect(createFolder({ title: "Eleventh" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(
      sent.some(
        (r) =>
          (r as { className?: string }).className ===
          "messages.UpdateDialogFilter",
      ),
    ).toBe(false);
  });
});

describe("deleteFolder", () => {
  it("sends an update with no filter and echoes what was deleted", async () => {
    const sent: unknown[] = [];
    __setClientFactoryForTests(factory({ sent }));
    const result = await deleteFolder({ folder_id: "2" });

    expect(result).toEqual({ deleted_folder_id: "2", title: "AI" });
    const update = lastUpdate(sent);
    expect(update.id).toBe(2);
    expect(update.filter).toBeUndefined();
  });

  it("refuses to delete a shareable folder", async () => {
    __setClientFactoryForTests(factory({ sent: [], filters: [chatlistFilter()] }));
    await expect(deleteFolder({ folder_id: "3" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });
});
