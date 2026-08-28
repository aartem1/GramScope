import { afterEach, describe, expect, it } from "vitest";
import {
  addFolderSources,
  createFolder,
  deleteFolder,
  removeFolderSources,
  reorderFolders,
  renameFolder,
  MAX_FOLDER_TITLE,
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
    __setClientFactoryForTests(factory({ sent, filters: [chatlistFilter()] }));
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

  it("rejects a rename to a title over the measured cap", async () => {
    // Same live cap as create: 13 characters fails with MESSAGE_TOO_LONG,
    // which used to surface as an INTERNAL_ERROR naming no limit.
    const sent: unknown[] = [];
    __setClientFactoryForTests(factory({ sent }));
    await expect(
      renameFolder({ folder_id: "2", title: "AI Research Sources" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(sent).toHaveLength(0);
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
    await createFolder({ title: "New", source_ids: ["@beta"] });
    expect(lastUpdate(sent).id).toBe(3);
  });

  it("reports the folder limit before calling Telegram", async () => {
    const sent: unknown[] = [];
    const many = Array.from({ length: 10 }, (_, i) => ({
      ...richFilter(),
      id: i + 2,
    }));
    __setClientFactoryForTests(factory({ sent, filters: many }));
    await expect(
      createFolder({ title: "Eleventh", source_ids: ["@beta"] }),
    ).rejects.toMatchObject({
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

  it("adds resolved sources while keeping the required empty peer vectors", async () => {
    const sent: unknown[] = [];
    __setClientFactoryForTests(factory({ sent }));

    await createFolder({ title: "New", source_ids: ["@beta"] });

    const filter = lastUpdate(sent).filter as Record<string, unknown>;
    expect(filter.includePeers).toHaveLength(1);
    expect(filter.pinnedPeers).toEqual([]);
    expect(filter.excludePeers).toEqual([]);
  });

  it("rejects an empty source list before creating a folder", async () => {
    __setClientFactoryForTests(factory({ sent: [] }));

    await expect(
      createFolder({ title: "New", source_ids: [] }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects an absent source list, naming the constraint", async () => {
    // Live 2026-08-29: Telegram answers a filter with an empty include list
    // with FILTER_INCLUDE_EMPTY, which the SAFE_CODE branch reported as
    // "INTERNAL_ERROR: Telegram error: FILTER_INCLUDE_EMPTY" — no code, no
    // retry guidance, on the sequence the tool advertised as primary.
    const sent: unknown[] = [];
    __setClientFactoryForTests(factory({ sent }));

    await expect(createFolder({ title: "New" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("source_ids"),
    });
    expect(
      sent.some(
        (r) =>
          (r as { className?: string }).className ===
          "messages.UpdateDialogFilter",
      ),
    ).toBe(false);
  });

  it("rejects a title over the measured Telegram cap", async () => {
    // Live 2026-08-29: 12 characters is accepted, 13 fails with
    // MESSAGE_TOO_LONG. "AI Research Sources" is 19.
    const sent: unknown[] = [];
    __setClientFactoryForTests(factory({ sent }));

    await expect(
      createFolder({ title: "AI Research Sources", source_ids: ["@beta"] }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(sent).toHaveLength(0);
  });

  it("accepts a title at exactly the cap", async () => {
    const sent: unknown[] = [];
    __setClientFactoryForTests(factory({ sent }));
    const exactly = "Twelve chars";
    expect(exactly).toHaveLength(MAX_FOLDER_TITLE);

    await createFolder({ title: exactly, source_ids: ["@beta"] });
    const filter = lastUpdate(sent).filter as { title: unknown };
    const title = filter.title as { text?: string } | string;
    expect(typeof title === "string" ? title : title.text).toBe(exactly);
  });

  it("does not create a folder when any source cannot resolve", async () => {
    const sent: unknown[] = [];
    __setClientFactoryForTests(async () => ({
      connected: true,
      connect: async () => true,
      invoke: async (request: unknown) => {
        sent.push(request);
        if (
          (request as { className?: string }).className ===
          "messages.GetDialogFilters"
        ) {
          return { filters: [richFilter()] };
        }
        return true;
      },
      getDialogs: async () => [],
      getEntity: async () => {
        throw Object.assign(new Error("gone"), {
          errorMessage: "USERNAME_NOT_OCCUPIED",
        });
      },
      getMessages: async () => [],
    }));

    await expect(
      createFolder({ title: "New", source_ids: ["@ghost"] }),
    ).rejects.toMatchObject({ code: "CHANNEL_NOT_FOUND" });
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
    __setClientFactoryForTests(
      factory({ sent: [], filters: [chatlistFilter()] }),
    );
    await expect(deleteFolder({ folder_id: "3" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });
});

describe("addFolderSources", () => {
  it("appends a resolved peer and preserves the unmodelled fields", async () => {
    const sent: unknown[] = [];
    __setClientFactoryForTests(factory({ sent }));
    await addFolderSources({ folder_id: "2", source_ids: ["@beta"] });

    const filter = lastUpdate(sent).filter as Record<string, unknown>;
    expect(filter.emoticon).toBe("🤖");
    expect(filter.pinnedPeers).toHaveLength(1);
    expect(filter.includePeers).toHaveLength(2);
  });

  it("does not add a peer the folder already holds", async () => {
    const sent: unknown[] = [];
    __setClientFactoryForTests(
      factory({
        sent,
        entities: {
          "-100111": { className: "Channel", id: { value: 111n } },
        },
      }),
    );
    await addFolderSources({ folder_id: "2", source_ids: ["-100111"] });
    const filter = lastUpdate(sent).filter as { includePeers: unknown[] };
    expect(filter.includePeers).toHaveLength(1);
  });

  it("fails the whole action when a source does not resolve", async () => {
    const sent: unknown[] = [];
    __setClientFactoryForTests(async () => ({
      connected: true,
      connect: async () => true,
      invoke: async (request: unknown) => {
        sent.push(request);
        if (
          (request as { className?: string }).className ===
          "messages.GetDialogFilters"
        ) {
          return { filters: [richFilter()] };
        }
        return true;
      },
      getDialogs: async () => [],
      getEntity: async () => {
        throw Object.assign(new Error("gone"), {
          errorMessage: "USERNAME_NOT_OCCUPIED",
        });
      },
      getMessages: async () => [],
    }));

    await expect(
      addFolderSources({ folder_id: "2", source_ids: ["@ghost"] }),
    ).rejects.toMatchObject({ code: "CHANNEL_NOT_FOUND" });
    expect(
      sent.some(
        (r) =>
          (r as { className?: string }).className ===
          "messages.UpdateDialogFilter",
      ),
    ).toBe(false);
  });

  it("rejects a call that would exceed the folder size limit", async () => {
    const sent: unknown[] = [];
    const full = {
      ...richFilter(),
      includePeers: Array.from({ length: 100 }, (_, i) => ({
        className: "InputPeerChannel",
        channelId: { value: BigInt(1000 + i) },
      })),
    };
    __setClientFactoryForTests(factory({ sent, filters: [full] }));
    await expect(
      addFolderSources({ folder_id: "2", source_ids: ["@beta"] }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects an empty source list", async () => {
    __setClientFactoryForTests(factory({ sent: [] }));

    await expect(
      addFolderSources({ folder_id: "2", source_ids: [] }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects more than 25 sources in one call", async () => {
    __setClientFactoryForTests(factory({ sent: [] }));
    await expect(
      addFolderSources({
        folder_id: "2",
        source_ids: Array.from({ length: 26 }, (_, i) => `-100${i}`),
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("removeFolderSources", () => {
  it("drops the named peer without resolving anything", async () => {
    const sent: unknown[] = [];
    __setClientFactoryForTests(async () => {
      const client = await factory({ sent })();
      return {
        ...client,
        getEntity: async () => {
          throw new Error("removal must not resolve peers");
        },
      };
    });

    await removeFolderSources({ folder_id: "2", source_ids: ["-100111"] });

    const filter = lastUpdate(sent).filter as Record<string, unknown>;
    expect(filter.includePeers).toHaveLength(0);
    expect(filter.pinnedPeers).toHaveLength(1);
  });

  it("is a no-op for a peer the folder does not hold", async () => {
    const sent: unknown[] = [];
    __setClientFactoryForTests(factory({ sent }));
    await removeFolderSources({ folder_id: "2", source_ids: ["-100555"] });
    const filter = lastUpdate(sent).filter as { includePeers: unknown[] };
    expect(filter.includePeers).toHaveLength(1);
  });

  it("rejects an empty source list", async () => {
    __setClientFactoryForTests(factory({ sent: [] }));

    await expect(
      removeFolderSources({ folder_id: "2", source_ids: [] }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects a @username instead of silently removing nothing", async () => {
    // The defect: a folder stores marked ids, so a username could never
    // match. The call rewrote the filter unchanged and reported success —
    // the post-state folder still holding the source the caller asked to
    // drop. add_sources accepts "@beta", so the two actions of one tool
    // disagreed about what a source_ids entry is, silently.
    const sent: unknown[] = [];
    __setClientFactoryForTests(factory({ sent }));

    await expect(
      removeFolderSources({ folder_id: "2", source_ids: ["@beta"] }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("included_peer_ids"),
    });
    expect(sent).toHaveLength(0);
  });

  it("rejects a t.me link naming a public channel", async () => {
    const sent: unknown[] = [];
    __setClientFactoryForTests(factory({ sent }));

    await expect(
      removeFolderSources({
        folder_id: "2",
        source_ids: ["https://t.me/beta"],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(sent).toHaveLength(0);
  });

  it("rejects every entry before touching a folder, not just the first", async () => {
    const sent: unknown[] = [];
    __setClientFactoryForTests(factory({ sent }));

    await expect(
      removeFolderSources({
        folder_id: "2",
        source_ids: ["-100111", "@beta"],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(sent).toHaveLength(0);
  });

  it("accepts a t.me/c link, which is a marked id in another spelling", async () => {
    const sent: unknown[] = [];
    __setClientFactoryForTests(factory({ sent }));

    await removeFolderSources({
      folder_id: "2",
      source_ids: ["https://t.me/c/111/9"],
    });
    const filter = lastUpdate(sent).filter as { includePeers: unknown[] };
    expect(filter.includePeers).toHaveLength(0);
  });
});

describe("reorderFolders", () => {
  it("sends the complete order", async () => {
    const sent: unknown[] = [];
    __setClientFactoryForTests(
      factory({
        sent,
        filters: [richFilter(), { ...richFilter(), id: 4 }],
      }),
    );
    await reorderFolders({ folder_ids: ["4", "2"] });

    const order = sent
      .filter(
        (r) =>
          (r as { className?: string }).className ===
          "messages.UpdateDialogFiltersOrder",
      )
      .at(-1) as { order?: number[] };
    expect(order?.order).toEqual([4, 2]);
  });

  it("rejects a partial order rather than silently dropping folders", async () => {
    const sent: unknown[] = [];
    __setClientFactoryForTests(
      factory({
        sent,
        filters: [richFilter(), { ...richFilter(), id: 4 }],
      }),
    );
    await expect(reorderFolders({ folder_ids: ["2"] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });
});
