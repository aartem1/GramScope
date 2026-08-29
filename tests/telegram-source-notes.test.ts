import { afterEach, describe, expect, it } from "vitest";
import {
  listSourceNotes,
  deleteSourceNote,
  noteMarker,
  parseNoteMessage,
  serializeNote,
  setSourceNote,
} from "@/telegram/source-notes";
import {
  __resetClientForTests,
  __setClientFactoryForTests,
} from "@/telegram/client";
import { __resetPeerCacheForTests } from "@/telegram/peer-resolve";
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
  __resetPeerCacheForTests();
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
  // class (Helpers.js:448) so this guards the module's plain-Array output
  // contract.
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

const dialogs = [
  {
    id: { value: -100111n },
    title: "Alpha",
    username: "alpha",
    unreadCount: 0,
    entity: { className: "Channel", id: { value: 111n }, username: "alpha" },
    dialog: {},
    message: { id: 100, date: 1735689600 },
  },
];

/** Records every TL request it is handed and applies sends, edits and deletes
 *  to its own message list, so a write followed by a read behaves like the
 *  real peer does. */
function writableFactory(initial: Array<{ id: number; message?: string }>) {
  const messages = [...initial];
  const sent: Array<Record<string, unknown>> = [];
  let nextId = Math.max(0, ...messages.map((m) => m.id)) + 1;
  const client = {
    connected: true,
    connect: async () => true,
    sent,
    editShouldFail: false,
    sendShouldFail: false,
    invoke: async (request: Record<string, unknown>) => {
      sent.push(request);
      const name = request.className as string;
      if (name?.endsWith("SendMessage")) {
        if (client.sendShouldFail) {
          throw new Error("replacement send failed");
        }
        messages.push({ id: nextId++, message: request.message as string });
        return { className: "Updates" };
      }
      if (name?.endsWith("EditMessage")) {
        if (client.editShouldFail) {
          throw Object.assign(new Error("expired"), {
            errorMessage: "MESSAGE_EDIT_TIME_EXPIRED",
          });
        }
        const target = messages.find((m) => m.id === request.id);
        if (target) target.message = request.message as string;
        return { className: "Updates" };
      }
      if (name?.endsWith("DeleteMessages")) {
        for (const id of request.id as number[]) {
          const at = messages.findIndex((m) => m.id === id);
          if (at >= 0) messages.splice(at, 1);
        }
        return { className: "AffectedMessages" };
      }
      return true;
    },
    getDialogs: async () => dialogs,
    getEntity: async () => ({ className: "User", id: { value: 1n } }),
    getMessages: async (_peer: string, params: Record<string, unknown>) => {
      const search = params.search as string | undefined;
      return messages
        .filter((m) => (search ? (m.message ?? "").includes(search) : true))
        .sort((a, b) => b.id - a.id)
        .slice(0, (params.limit as number) ?? 100);
    },
  };
  return { client, messages, sent };
}

const input = {
  source_id: "-100111",
  about: "Covers **launches** and `orbital` mechanics.",
  topics: ["space", "launches"],
  kind: "reporting" as const,
  lang: "ru",
};

describe("setSourceNote", () => {
  it("writes a first note, fills the server fields and reports replaced false", async () => {
    const fake = writableFactory([]);
    __setClientFactoryForTests((async () => fake.client) as never);

    const result = await setSourceNote(input);

    expect(result.replaced).toBe(false);
    expect(result.note.id).toBe("-100111");
    expect(result.note.title).toBe("Alpha");
    expect(result.note.handle).toBe("@alpha");
    expect(result.note.about).toBe(input.about);
    expect(result.note.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("sends through the raw TL call so the text is not re-parsed", async () => {
    const fake = writableFactory([]);
    __setClientFactoryForTests((async () => fake.client) as never);

    await setSourceNote(input);

    const send = fake.sent.find((r) =>
      String(r.className).endsWith("SendMessage"),
    );
    expect(send).toBeDefined();
    expect(String(send!.message)).toContain("**launches**");
    expect(send!.entities).toBeUndefined();
  });

  it("edits in place when a note already exists", async () => {
    const fake = writableFactory([]);
    __setClientFactoryForTests((async () => fake.client) as never);

    await setSourceNote(input);
    const second = await setSourceNote({ ...input, about: "Rewritten." });

    expect(second.replaced).toBe(true);
    expect(second.note.about).toBe("Rewritten.");
    expect(fake.messages).toHaveLength(1);
    expect(
      fake.sent.some((r) => String(r.className).endsWith("EditMessage")),
    ).toBe(true);
  });

  it("falls back to delete-and-resend when the edit window has closed", async () => {
    const fake = writableFactory([]);
    __setClientFactoryForTests((async () => fake.client) as never);

    await setSourceNote(input);
    fake.client.editShouldFail = true;
    const second = await setSourceNote({ ...input, about: "Rewritten." });

    expect(second.note.about).toBe("Rewritten.");
    expect(fake.messages).toHaveLength(1);
    expect(
      fake.sent.filter((r) => String(r.className).endsWith("SendMessage")),
    ).toHaveLength(2);
  });

  it("preserves the original note when edit and replacement send both fail", async () => {
    const original = stored("-100111", { about: "Original note." });
    const fake = writableFactory([{ id: 5, message: original }]);
    fake.client.editShouldFail = true;
    fake.client.sendShouldFail = true;
    __setClientFactoryForTests((async () => fake.client) as never);

    await expect(
      setSourceNote({ ...input, about: "Replacement note." }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });

    expect(fake.messages).toEqual([{ id: 5, message: original }]);
  });

  it("reconciles concurrent first writes to the newest valid note", async () => {
    const fake = writableFactory([]);
    const readMessages = fake.client.getMessages;
    let initialLookups = 0;
    let releaseInitialLookups = () => {};
    const bothInitialLookups = new Promise<void>((resolve) => {
      releaseInitialLookups = resolve;
    });
    fake.client.getMessages = async (peer, params) => {
      if (
        params.search === noteMarker("-100111") &&
        initialLookups < 2
      ) {
        initialLookups += 1;
        if (initialLookups === 2) releaseInitialLookups();
        await bothInitialLookups;
        return [];
      }
      return readMessages(peer, params);
    };
    __setClientFactoryForTests((async () => fake.client) as never);

    await Promise.all([
      setSourceNote({ ...input, about: "First concurrent write." }),
      setSourceNote({ ...input, about: "Second concurrent write." }),
    ]);

    expect(initialLookups).toBe(2);
    expect(fake.messages).toHaveLength(1);
    const sends = fake.sent.filter((request) =>
      String(request.className).endsWith("SendMessage"),
    );
    expect(sends).toHaveLength(2);
    expect(fake.messages[0]!.message).toBe(sends[1]!.message);

    const listed = await listSourceNotes({ source_ids: ["-100111"] });
    expect(listed.notes).toHaveLength(1);
    expect(listed.duplicates).toEqual([]);
    expect(listed.malformed).toEqual([]);
  });

  it("collapses duplicates left by an interrupted write", async () => {
    const fake = writableFactory([
      { id: 5, message: stored("-100111", { about: "old one" }) },
      { id: 6, message: stored("-100111", { about: "old two" }) },
    ]);
    __setClientFactoryForTests((async () => fake.client) as never);

    const result = await setSourceNote(input);

    expect(result.replaced).toBe(true);
    expect(fake.messages).toHaveLength(1);
  });

  it("removes malformed messages attributed to the rewritten source", async () => {
    const fake = writableFactory([
      { id: 5, message: stored("-100111", { about: "old" }) },
      { id: 6, message: "gs:src:100111\nbroken" },
    ]);
    __setClientFactoryForTests((async () => fake.client) as never);

    await setSourceNote(input);

    expect(fake.messages).toHaveLength(1);
    expect(fake.messages[0]!.message).toContain(input.about);
  });

  it("writes a note about a source the account has not joined", async () => {
    const fake = writableFactory([]);
    // Not in `dialogs`, so resolution goes over the network the way a channel
    // found by search does. Spec §6.1: membership is not required, resolution
    // is — a conclusion about a source not worth joining is exactly the one
    // that should not have to be re-derived.
    fake.client.getEntity = (async () => ({
      className: "Channel",
      id: { value: 777n },
      title: "Found by search",
      username: "found",
    })) as never;
    __setClientFactoryForTests((async () => fake.client) as never);

    const result = await setSourceNote({ ...input, source_id: "@found" });

    expect(result.note.id).toBe("-100777");
    expect(result.note.handle).toBe("@found");
    expect(result.replaced).toBe(false);
  });

  it("rejects an over-long about before touching the network", async () => {
    const fake = writableFactory([]);
    __setClientFactoryForTests((async () => fake.client) as never);

    await expect(
      setSourceNote({ ...input, about: "x".repeat(301) }),
    ).rejects.toThrow(/300/);
    expect(fake.sent).toHaveLength(0);
  });
});

describe("deleteSourceNote", () => {
  it("deletes every well-formed message carrying the source's marker", async () => {
    const fake = writableFactory([
      { id: 5, message: stored("-100111") },
      { id: 6, message: stored("-100111") },
      { id: 7, message: stored("-100222") },
    ]);
    __setClientFactoryForTests((async () => fake.client) as never);

    const result = await deleteSourceNote("-100111");

    expect(result.deleted).toBe(true);
    expect(fake.messages.map((m) => m.id)).toEqual([7]);
  });

  it("reports deleted false when there was no note", async () => {
    const fake = writableFactory([{ id: 7, message: stored("-100222") }]);
    __setClientFactoryForTests((async () => fake.client) as never);

    const result = await deleteSourceNote("-100111");

    expect(result.deleted).toBe(false);
    expect(fake.messages).toHaveLength(1);
  });

  it("deletes malformed messages attributed to the exact source marker", async () => {
    const fake = writableFactory([
      { id: 5, message: "gs:src:100111\nbroken" },
      { id: 6, message: "gs:src:100111\n{\\\"id\\\":\\\"-100111\\\"}" },
      { id: 7, message: "gs:src:1001119\nbroken" },
    ]);
    __setClientFactoryForTests((async () => fake.client) as never);

    const result = await deleteSourceNote("-100111");

    expect(result.deleted).toBe(true);
    expect(fake.messages.map((m) => m.id)).toEqual([7]);
  });

  it("deletes both well-formed and malformed messages in a mixed set", async () => {
    const fake = writableFactory([
      { id: 5, message: stored("-100111") },
      { id: 6, message: "gs:src:100111\nbroken" },
      { id: 7, message: stored("-100222") },
    ]);
    __setClientFactoryForTests((async () => fake.client) as never);

    const result = await deleteSourceNote("-100111");

    expect(result.deleted).toBe(true);
    expect(fake.messages.map((m) => m.id)).toEqual([7]);
  });
});
