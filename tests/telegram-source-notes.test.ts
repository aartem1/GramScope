import { afterEach, describe, expect, it } from "vitest";
import {
  listSourceNotes,
  noteMarker,
  parseNoteMessage,
  serializeNote,
} from "@/telegram/source-notes";
import {
  __resetClientForTests,
  __setClientFactoryForTests,
} from "@/telegram/client";
import type { SourceNote } from "@/schemas/source-note";

const note: SourceNote = {
  id: "-1002222222222",
  handle: "@examplechannel",
  title: "My **Cosmos**",
  about:
    'Covers `launches`, _orbital_ mechanics and **originals**; calls itself "the" source.',
  topics: ["space", "launches"],
  kind: "reporting",
  lang: "ru",
  cadence: "5-10/day",
  derived_from: "last 40 posts",
  updated: "2026-08-29",
};

describe("noteMarker", () => {
  it("drops the sign of a marked channel id", () => {
    expect(noteMarker("-1002222222222")).toBe("gs:src:1002222222222");
  });

  it("leaves a positive id alone", () => {
    expect(noteMarker("333")).toBe("gs:src:333");
  });
});

describe("serializeNote / parseNoteMessage", () => {
  it("round-trips a note whose text carries markdown and quotes", () => {
    const outcome = parseNoteMessage(serializeNote(note));
    expect(outcome.kind).toBe("note");
    if (outcome.kind !== "note") return;
    expect(outcome.note).toEqual(note);
  });

  it("puts the marker on its own first line", () => {
    const [first] = serializeNote(note).split("\n");
    expect(first).toBe("gs:src:1002222222222");
  });

  it("reports a message without the marker as not a note", () => {
    expect(parseNoteMessage("just some text").kind).toBe("other");
  });

  it("reports a marked message whose body is not JSON as malformed", () => {
    const outcome = parseNoteMessage("gs:src:100111\nnot json at all");
    expect(outcome.kind).toBe("malformed");
    if (outcome.kind !== "malformed") return;
    expect(outcome.reason).toContain("JSON");
  });

  it("reports a marked message whose JSON is not a note as malformed", () => {
    const outcome = parseNoteMessage('gs:src:100111\n{"id":"-100111"}');
    expect(outcome.kind).toBe("malformed");
  });

  it("reports a note whose marker disagrees with its id as malformed", () => {
    const wrong = serializeNote(note).replace(
      "gs:src:1002222222222",
      "gs:src:999",
    );
    const outcome = parseNoteMessage(wrong);
    expect(outcome.kind).toBe("malformed");
    if (outcome.kind !== "malformed") return;
    expect(outcome.reason).toContain("marker");
  });

  it("reports a marked line with non-digit suffix as malformed", () => {
    const outcome = parseNoteMessage("gs:src:12x\n{}");
    expect(outcome.kind).toBe("malformed");
    if (outcome.kind !== "malformed") return;
    expect(outcome.reason).toContain("digits");
  });

  it("reports a bare marked line with no body as malformed", () => {
    const outcome = parseNoteMessage("gs:src:123");
    expect(outcome.kind).toBe("malformed");
    if (outcome.kind !== "malformed") return;
    expect(outcome.reason).toContain("body");
  });
});

function stored(id: string, extra: Partial<SourceNote> = {}): string {
  return serializeNote({ ...note, id, handle: undefined, ...extra });
}

/** A fake peer whose getMessages honours `search`, `limit` and `offsetId` the
 *  way Telegram does: newest first, strictly below offsetId when it is set. */
function factory(messages: Array<{ id: number; message?: string }>) {
  return async () => ({
    connected: true,
    connect: async () => true,
    invoke: async () => true,
    getDialogs: async () => [],
    getEntity: async () => ({ className: "User", id: { value: 1n } }),
    getMessages: async (_peer: string, params: Record<string, unknown>) => {
      const search = params.search as string | undefined;
      const offsetId = (params.offsetId as number) ?? 0;
      const limit = (params.limit as number) ?? 100;
      return messages
        .filter((m) => (offsetId ? m.id < offsetId : true))
        .filter((m) => (search ? (m.message ?? "").includes(search) : true))
        .sort((a, b) => b.id - a.id)
        .slice(0, limit);
    },
  });
}

afterEach(() => {
  __setClientFactoryForTests(undefined);
  __resetClientForTests();
});

describe("listSourceNotes", () => {
  it("returns every note in the peer when asked for nothing in particular", async () => {
    __setClientFactoryForTests(
      factory([
        { id: 10, message: stored("-100111") },
        { id: 11, message: stored("-100222") },
      ]) as never,
    );
    const result = await listSourceNotes({});
    expect(result.notes.map((n) => n.id)).toEqual(["-100222", "-100111"]);
    expect(result.duplicates).toEqual([]);
    expect(result.malformed).toEqual([]);
  });

  it("skips a service message and any other non-note", async () => {
    __setClientFactoryForTests(
      factory([
        { id: 10, message: stored("-100111") },
        { id: 9 },
        { id: 8, message: "an ordinary message" },
      ]) as never,
    );
    const result = await listSourceNotes({});
    expect(result.notes).toHaveLength(1);
    expect(result.malformed).toEqual([]);
  });

  it("reports a malformed note without losing the rest", async () => {
    __setClientFactoryForTests(
      factory([
        { id: 10, message: stored("-100111") },
        { id: 9, message: "gs:src:100222\nbroken" },
      ]) as never,
    );
    const result = await listSourceNotes({});
    expect(result.notes).toHaveLength(1);
    expect(result.malformed).toEqual([
      { message_id: 9, reason: "body is not valid JSON" },
    ]);
  });

  it("reports duplicates and keeps the newest", async () => {
    __setClientFactoryForTests(
      factory([
        { id: 10, message: stored("-100111", { about: "older" }) },
        { id: 12, message: stored("-100111", { about: "newer" }) },
      ]) as never,
    );
    const result = await listSourceNotes({});
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]!.about).toBe("newer");
    expect(result.duplicates).toEqual([
      { source_id: "-100111", message_ids: [12, 10] },
    ]);
  });

  it("fetches named sources by marker and ignores a prefix collision", async () => {
    __setClientFactoryForTests(
      factory([
        { id: 10, message: stored("-100111") },
        { id: 11, message: stored("-1001119") },
      ]) as never,
    );
    const result = await listSourceNotes({ source_ids: ["-100111"] });
    expect(result.notes.map((n) => n.id)).toEqual(["-100111"]);
    expect(result.next_cursor).toBeUndefined();
  });

  it("reports a malformed note for a named source and contributes no note", async () => {
    __setClientFactoryForTests(
      factory([{ id: 9, message: "gs:src:100111\nbroken" }]) as never,
    );
    const result = await listSourceNotes({ source_ids: ["-100111"] });
    expect(result.notes).toEqual([]);
    expect(result.malformed).toEqual([
      { message_id: 9, reason: "body is not valid JSON" },
    ]);
  });

  it("returns the note and reports a malformed copy found under the same marker", async () => {
    __setClientFactoryForTests(
      factory([
        { id: 10, message: stored("-100111") },
        { id: 9, message: "gs:src:100111\nbroken" },
      ]) as never,
    );
    const result = await listSourceNotes({ source_ids: ["-100111"] });
    expect(result.notes.map((n) => n.id)).toEqual(["-100111"]);
    expect(result.malformed).toEqual([
      { message_id: 9, reason: "body is not valid JSON" },
    ]);
  });

  it("rejects more source_ids than one call may name", async () => {
    __setClientFactoryForTests(factory([]) as never);
    const ids = Array.from({ length: 26 }, (_, i) => `-1001${i}`);
    await expect(listSourceNotes({ source_ids: ids })).rejects.toThrow(
      /at most 25/,
    );
  });

  it("pages with a cursor and refuses one from another query", async () => {
    __setClientFactoryForTests(
      factory([
        { id: 10, message: stored("-100111") },
        { id: 11, message: stored("-100222") },
      ]) as never,
    );
    const first = await listSourceNotes({ limit: 1 });
    expect(first.notes.map((n) => n.id)).toEqual(["-100222"]);
    expect(first.next_cursor).toBeDefined();

    const second = await listSourceNotes({
      limit: 1,
      cursor: first.next_cursor,
    });
    expect(second.notes.map((n) => n.id)).toEqual(["-100111"]);

    await expect(
      listSourceNotes({ limit: 1, query: "other", cursor: first.next_cursor }),
    ).rejects.toThrow(/scope/i);
  });

  // teleproto returns a TotalList — an Array subclass carrying a `total`
  // property — and filter/map/sort preserve the subclass through
  // Symbol.species. The other fakes in this file build their result from a
  // plain array, which would hide a leak; this one mirrors teleproto's own
  // class (Helpers.js:448) so a dropped Array.from in fetchPage fails here.
  it("returns plain arrays, not the TL library's Array subclass", async () => {
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
      (async () => ({
        connected: true,
        connect: async () => true,
        invoke: async () => true,
        getDialogs: async () => [],
        getEntity: async () => ({ className: "User", id: { value: 1n } }),
        getMessages: async () =>
          totalList([{ id: 10, message: stored("-100111") }]),
      })) as never,
    );

    const result = await listSourceNotes({});
    expect(result.notes.constructor).toBe(Array);
  });
});
