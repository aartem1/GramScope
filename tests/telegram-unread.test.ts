import { describe, expect, it } from "vitest";
import { summarize } from "@/telegram/unread";
import type { DialogEntry, DialogIndex } from "@/telegram/dialog-index";
import { GramScopeError } from "@/errors/taxonomy";
import { MAX_RESPONSE_BYTES } from "@/schemas/size";

const A = "-100111";
const B = "-100222";
const C = "-100333";

const index: DialogIndex = {
  byId: new Map([
    [
      A,
      {
        source_id: A,
        title: "Alpha",
        unread_count: 3,
        read_inbox_max_id: 90,
        latest_message_id: 93,
        latest_message_date: "2025-01-01T00:00:00.000Z",
        folder_ids: ["2"],
      },
    ],
    [
      B,
      {
        source_id: B,
        title: "Beta",
        unread_count: 12,
        read_inbox_max_id: 40,
        folder_ids: ["2"],
      },
    ],
    [
      C,
      {
        source_id: C,
        title: "Gamma",
        unread_count: 0,
        read_inbox_max_id: 7,
        folder_ids: ["3"],
      },
    ],
  ]),
  folders: [
    {
      id: "2",
      title: "AI",
      included_peer_ids: [A, B],
      excluded_peer_ids: [],
      order: 0,
    },
    {
      id: "3",
      title: "News",
      included_peer_ids: [C],
      excluded_peer_ids: [],
      order: 1,
    },
  ],
};

describe("summarize by source", () => {
  it("returns only sources with unread, busiest first", () => {
    const result = summarize(index, {});
    expect(result.groups.map((g) => g.source_id)).toEqual([B, A]);
    expect(result.total_unread).toBe(15);
  });

  it("carries the read pointer and latest message", () => {
    const [, alpha] = summarize(index, {}).groups;
    expect(alpha).toMatchObject({
      source_id: A,
      title: "Alpha",
      unread_count: 3,
      read_inbox_max_id: 90,
      latest_message_id: 93,
      latest_message_date: "2025-01-01T00:00:00.000Z",
    });
  });

  it("narrows to the given folders", () => {
    const result = summarize(index, { folder_ids: ["3"] });
    expect(result.groups).toEqual([]);
    expect(result.total_unread).toBe(0);
  });

  it("never returns the oldest-unread date", () => {
    // Deliberately absent: it costs one request per source, and
    // get_messages(unread_only, limit 1) already answers it.
    expect(JSON.stringify(summarize(index, {}))).not.toContain("oldest");
  });
});

describe("summarize by folder", () => {
  it("sums each folder's members and omits the per-folder pointer", () => {
    const result = summarize(index, { group_by: "folder" });
    expect(result.groups).toEqual([
      { folder_id: "2", title: "AI", unread_count: 15 },
    ]);
    expect(result.total_unread).toBe(15);
  });

  it("rejects an unknown folder id", () => {
    const error = (() => {
      try {
        summarize(index, { group_by: "folder", folder_ids: ["99"] });
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(GramScopeError);
    expect((error as GramScopeError).code).toBe("INVALID_INPUT");
  });

  it("caps folder groups while preserving total unread", () => {
    const count = 600;
    const folders = Array.from({ length: count }, (_, i) => {
      const id = String(i + 10);
      const sourceId = `-100${i + 1000}`;
      return {
        id,
        title: `Folder ${i} ${"x".repeat(600)}`,
        included_peer_ids: [sourceId],
        excluded_peer_ids: [],
        order: i,
      };
    });
    const byId = new Map(
      folders.map((folder) => {
        const sourceId = folder.included_peer_ids[0]!;
        const entry: DialogEntry = {
          source_id: sourceId,
          title: sourceId,
          unread_count: 1,
          read_inbox_max_id: 0,
          folder_ids: [folder.id],
        };
        return [sourceId, entry] as const;
      }),
    );

    const result = summarize({ byId, folders }, { group_by: "folder" });

    expect(result.groups.length).toBeLessThan(count);
    expect(result.total_unread).toBe(count);
    expect(
      Buffer.byteLength(JSON.stringify(result), "utf8"),
    ).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
  });
});

describe("summarize response size envelope", () => {
  it("counts total_unread in the source size cap", () => {
    const makeEntries = (titleLength: number) =>
      [A, B].map((sourceId) => ({
        source_id: sourceId,
        title: "x".repeat(titleLength),
        unread_count: 1,
        read_inbox_max_id: 0,
        folder_ids: [],
      }));
    const makeGroups = (titleLength: number) =>
      makeEntries(titleLength).map(
        ({ source_id, title, unread_count, read_inbox_max_id }) => ({
          source_id,
          title,
          unread_count,
          read_inbox_max_id,
        }),
      );
    const size = (titleLength: number, withTotal: boolean) => {
      const groups = makeGroups(titleLength);
      return Buffer.byteLength(
        JSON.stringify(withTotal ? { groups, total_unread: 2 } : { groups }),
        "utf8",
      );
    };
    let titleLength = Math.floor((MAX_RESPONSE_BYTES - size(0, false)) / 2);
    while (size(titleLength, false) > MAX_RESPONSE_BYTES) titleLength--;
    while (size(titleLength, true) <= MAX_RESPONSE_BYTES) titleLength++;
    titleLength--;

    const groups = makeEntries(titleLength);
    expect(size(titleLength, false)).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
    expect(size(titleLength, true)).toBeGreaterThan(MAX_RESPONSE_BYTES);

    const result = summarize(
      {
        byId: new Map(groups.map((entry) => [entry.source_id, entry])),
        folders: [],
      },
      {},
    );

    expect(result.groups).toHaveLength(1);
    expect(result.total_unread).toBe(2);
    expect(
      Buffer.byteLength(JSON.stringify(result), "utf8"),
    ).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
  });
});

describe("the manual unread flag in the summary", () => {
  function indexWith(entries: Partial<DialogEntry>[]): DialogIndex {
    const byId = new Map<string, DialogEntry>();
    for (const entry of entries) {
      const full: DialogEntry = {
        source_id: entry.source_id!,
        title: entry.title ?? entry.source_id!,
        unread_count: entry.unread_count ?? 0,
        read_inbox_max_id: 0,
        folder_ids: [],
        ...(entry.unread_mark ? { unread_mark: true } : {}),
      };
      byId.set(full.source_id, full);
    }
    return { byId, folders: [] };
  }

  it("includes a flagged source that has no unread messages", () => {
    // Without this, mark_unread ships decorative: it sets a flag no tool can
    // see. Same failure that moved mark_read into sub-project 2.
    const result = summarize(
      indexWith([
        { source_id: "-100111", title: "Counted", unread_count: 3 },
        { source_id: "-100222", title: "Flagged", unread_mark: true },
      ]),
      {},
    );
    expect(result.groups.map((g) => g.source_id)).toEqual([
      "-100111",
      "-100222",
    ]);
    expect(result.groups[1]!.unread_mark).toBe(true);
    expect(result.groups[1]!.unread_count).toBe(0);
  });

  it("leaves total_unread a message count", () => {
    const result = summarize(
      indexWith([
        { source_id: "-100111", unread_count: 3 },
        { source_id: "-100222", unread_mark: true },
      ]),
      {},
    );
    expect(result.total_unread).toBe(3);
  });

  it("sorts a flagged source ahead of an unflagged one at the same count", () => {
    const result = summarize(
      indexWith([
        { source_id: "-100111", unread_count: 5 },
        { source_id: "-100222", unread_count: 5, unread_mark: true },
      ]),
      {},
    );
    expect(result.groups.map((g) => g.source_id)).toEqual([
      "-100222",
      "-100111",
    ]);
  });

  it("still reports nothing for a source with neither count nor flag", () => {
    const result = summarize(indexWith([{ source_id: "-100111" }]), {});
    expect(result.groups).toEqual([]);
  });
});
