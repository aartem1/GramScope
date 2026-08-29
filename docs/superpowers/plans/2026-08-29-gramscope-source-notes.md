# GramScope Source Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the agent a durable, compact memory about sources — one note per source, stored in Telegram Saved Messages — so a question can be routed to the right channels without re-reading them.

**Architecture:** One message per note in the `me` peer. Line one is a search marker, the rest is a JSON object. A single module owns that wire format; two tools sit on top of it, one write and one read. Writes go through raw TL calls because teleproto's high-level send rewrites the text.

**Tech Stack:** TypeScript, Next.js on Vercel, `@modelcontextprotocol/server`, teleproto (MTProto), zod, vitest.

**Spec:** `docs/superpowers/specs/2026-08-29-gramscope-source-notes-design.md`

## Global Constraints

- Branch `main`. The owner works directly on `main` and everything is pushed; no per-task branches.
- All code, comments, commit messages and docs in English. The owner is addressed in Russian, artifacts are English.
- Version after this sub-project: **1.4.0**, in `package.json`, `package-lock.json` and `src/mcp/version.ts`. Tests pin all three.
- **Nineteen tools** after this sub-project.
- Marker format: `gs:src:` + the marked id with any leading `-` removed. `-1002222222222` → `gs:src:1002222222222`.
- Caps, enforced on tool input, each rejection naming its own limit: `about` ≤ 300 characters; `topics` 1–12 items, each ≤ 32 characters; `lang` ≤ 16; `cadence` ≤ 32; `derived_from` ≤ 60. `source_ids` on the read bounded by `MAX_SOURCES_PER_CALL` (25).
- `kind` enum: `reporting`, `aggregator`, `opinion`, `promo`, `mixed`.
- **No new error codes.** `INVALID_INPUT` for caps, `CHANNEL_NOT_FOUND` for an unresolvable source, everything else as elsewhere.
- Tool descriptions state only what is specific to that tool. Server-wide guidance lives once in `SERVER_INSTRUCTIONS` (`src/mcp/instructions.ts`) and must not be repeated.
- Run `npm run test` (fast tier), `npm run typecheck`, `npm run lint` before each commit. `npm run test:live` only in Task 9.

---

## File Structure

Created:

| File                                   | Responsibility                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| `src/schemas/source-note.ts`           | The note shape, the caps, the `kind` enum, the input guard                               |
| `src/telegram/source-notes.ts`         | The only module that knows the wire format; serialize, parse, find, list, upsert, delete |
| `src/mcp/tools/get-source-notes.ts`    | Read tool registration                                                                   |
| `src/mcp/tools/set-source-note.ts`     | Write tool registration                                                                  |
| `tests/schemas-source-note.test.ts`    | Caps and shape                                                                           |
| `tests/telegram-source-notes.test.ts`  | Format and engine, against a fake client                                                 |
| `tests/live/source-notes.live.test.ts` | The live tier                                                                            |

Modified: `src/pagination.ts` (one cursor kind), `src/mcp/server.ts`, `src/mcp/version.ts`, `tests/tool-names.ts`, `tests/tools.test.ts`, `tests/mcp-handler.test.ts`, `README.md`, `docs/chatgpt-project-instructions.md`, `package.json`, `package-lock.json`.

`src/telegram/client.ts` is NOT modified: send, edit and delete go through the already-declared `invoke`, reads through the already-declared `getMessages`.

---

### Task 1: The note shape and its caps

**Files:**

- Create: `src/schemas/source-note.ts`
- Test: `tests/schemas-source-note.test.ts`

**Interfaces:**

- Consumes: `GramScopeError` from `src/errors/taxonomy.ts`.
- Produces: `NOTE_KINDS`, `NoteKind`, `sourceNoteSchema`, `SourceNote`, `SourceNoteInput`, `assertNoteInputBounded(input: SourceNoteInput): void`, and the cap constants `MAX_ABOUT_CHARS`, `MAX_TOPICS`, `MAX_TOPIC_CHARS`, `MAX_LANG_CHARS`, `MAX_CADENCE_CHARS`, `MAX_DERIVED_FROM_CHARS`.

There are deliberately two mechanisms here. `sourceNoteSchema` parses notes coming BACK from Telegram and must stay permissive: a note stored before a cap changed is still a note, and a read that rejected it would lose data the agent wrote. `assertNoteInputBounded` guards what goes IN, and it throws the house error with the limit named, because a rejection that does not name its limit tells an agent nothing about how to retry.

- [ ] **Step 1: Write the failing test**

```ts
// tests/schemas-source-note.test.ts
import { describe, expect, it } from "vitest";
import {
  assertNoteInputBounded,
  MAX_ABOUT_CHARS,
  MAX_TOPICS,
  sourceNoteSchema,
  type SourceNoteInput,
} from "@/schemas/source-note";
import { GramScopeError } from "@/errors/taxonomy";

const valid: SourceNoteInput = {
  about: "Daily launch coverage with original photography.",
  topics: ["space", "launches"],
  kind: "reporting",
};

describe("assertNoteInputBounded", () => {
  it("accepts a note within every cap", () => {
    expect(() => assertNoteInputBounded(valid)).not.toThrow();
  });

  it("rejects an over-long about and names the limit", () => {
    const input = { ...valid, about: "x".repeat(MAX_ABOUT_CHARS + 1) };
    try {
      assertNoteInputBounded(input);
      throw new Error("expected a rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(GramScopeError);
      expect((err as GramScopeError).code).toBe("INVALID_INPUT");
      expect((err as GramScopeError).message).toContain(
        String(MAX_ABOUT_CHARS),
      );
    }
  });

  it("rejects an empty topics list", () => {
    expect(() => assertNoteInputBounded({ ...valid, topics: [] })).toThrow(
      GramScopeError,
    );
  });

  it("rejects too many topics and names the limit", () => {
    const topics = Array.from({ length: MAX_TOPICS + 1 }, (_, i) => `t${i}`);
    try {
      assertNoteInputBounded({ ...valid, topics });
      throw new Error("expected a rejection");
    } catch (err) {
      expect((err as GramScopeError).message).toContain(String(MAX_TOPICS));
    }
  });

  it("rejects an over-long single topic", () => {
    expect(() =>
      assertNoteInputBounded({ ...valid, topics: ["x".repeat(33)] }),
    ).toThrow(GramScopeError);
  });

  it("rejects a blank topic", () => {
    expect(() => assertNoteInputBounded({ ...valid, topics: ["  "] })).toThrow(
      GramScopeError,
    );
  });
});

describe("sourceNoteSchema", () => {
  it("parses a stored note", () => {
    const parsed = sourceNoteSchema.parse({
      id: "-1002222222222",
      handle: "@examplechannel",
      title: "Example Channel",
      about: "Launch coverage.",
      topics: ["space"],
      kind: "reporting",
      updated: "2026-08-29",
    });
    expect(parsed.id).toBe("-1002222222222");
  });

  it("stays permissive about a stored note that exceeds a current cap", () => {
    const parsed = sourceNoteSchema.parse({
      id: "-100111",
      title: "Old",
      about: "y".repeat(MAX_ABOUT_CHARS + 50),
      topics: ["a"],
      kind: "mixed",
      updated: "2026-01-01",
    });
    expect(parsed.about.length).toBeGreaterThan(MAX_ABOUT_CHARS);
  });

  it("rejects an unknown kind", () => {
    expect(() =>
      sourceNoteSchema.parse({
        id: "-100111",
        title: "Old",
        about: "a",
        topics: ["a"],
        kind: "newsletter",
        updated: "2026-01-01",
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/schemas-source-note.test.ts`
Expected: FAIL — cannot resolve `@/schemas/source-note`.

- [ ] **Step 3: Write the implementation**

```ts
// src/schemas/source-note.ts
import { z } from "zod";
import { GramScopeError } from "../errors/taxonomy";

/**
 * What a source IS, epistemically — not what it covers. The field exists so a
 * later read can weigh the content: an aggregator's post is a pointer, an
 * opinion channel's post is its author's claim. Spec §5.
 */
export const NOTE_KINDS = [
  "reporting",
  "aggregator",
  "opinion",
  "promo",
  "mixed",
] as const;

export type NoteKind = (typeof NOTE_KINDS)[number];

export const MAX_ABOUT_CHARS = 300;
export const MAX_TOPICS = 12;
export const MAX_TOPIC_CHARS = 32;
export const MAX_LANG_CHARS = 16;
export const MAX_CADENCE_CHARS = 32;
export const MAX_DERIVED_FROM_CHARS = 60;

/**
 * A note as it is STORED and read back. Deliberately permissive about length:
 * a note written under an older cap is still a note, and a reader that
 * rejected it would destroy the memory it exists to serve. Input is guarded
 * separately, by assertNoteInputBounded.
 */
export const sourceNoteSchema = z.object({
  id: z.string(),
  handle: z.string().optional(),
  title: z.string(),
  about: z.string(),
  topics: z.array(z.string()),
  kind: z.enum(NOTE_KINDS),
  lang: z.string().optional(),
  cadence: z.string().optional(),
  derived_from: z.string().optional(),
  updated: z.string(),
});

export type SourceNote = z.infer<typeof sourceNoteSchema>;

/** The agent-supplied half. id, handle, title and updated are server-derived. */
export type SourceNoteInput = {
  about: string;
  topics: string[];
  kind: NoteKind;
  lang?: string;
  cadence?: string;
  derived_from?: string;
};

function assertLength(
  value: string | undefined,
  field: string,
  limit: number,
): void {
  if (value === undefined) return;
  if (value.length <= limit) return;
  throw new GramScopeError(
    "INVALID_INPUT",
    `${field} is ${value.length} characters; the limit is ${limit}. Shorten it.`,
  );
}

/**
 * The caps that keep the store compact. They are the owner's one binding
 * constraint on this feature — the memory must not become a dump — expressed
 * as a refusal rather than as advice, because advice in a tool description is
 * not enforcement.
 */
export function assertNoteInputBounded(input: SourceNoteInput): void {
  assertLength(input.about, "about", MAX_ABOUT_CHARS);
  assertLength(input.lang, "lang", MAX_LANG_CHARS);
  assertLength(input.cadence, "cadence", MAX_CADENCE_CHARS);
  assertLength(input.derived_from, "derived_from", MAX_DERIVED_FROM_CHARS);

  if (input.topics.length === 0) {
    throw new GramScopeError(
      "INVALID_INPUT",
      "topics must name at least one topic; it is what makes the note findable.",
    );
  }
  if (input.topics.length > MAX_TOPICS) {
    throw new GramScopeError(
      "INVALID_INPUT",
      `topics has ${input.topics.length} entries; the limit is ${MAX_TOPICS}. Keep the ones a question would actually be asked about.`,
    );
  }
  for (const topic of input.topics) {
    if (topic.trim().length === 0) {
      throw new GramScopeError(
        "INVALID_INPUT",
        "topics must not contain a blank entry",
      );
    }
    assertLength(topic, `topic ${JSON.stringify(topic)}`, MAX_TOPIC_CHARS);
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/schemas-source-note.test.ts && npm run typecheck && npm run lint`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/schemas/source-note.ts tests/schemas-source-note.test.ts
git commit -m "feat: source note shape and input caps"
```

---

### Task 2: The wire format

**Files:**

- Create: `src/telegram/source-notes.ts`
- Test: `tests/telegram-source-notes.test.ts`

**Interfaces:**

- Consumes: `sourceNoteSchema`, `SourceNote` from Task 1.
- Produces: `noteMarker(sourceId: string): string`, `serializeNote(note: SourceNote): string`, `parseNoteMessage(text: string): ParseOutcome`, where
  `type ParseOutcome = { ok: true; note: SourceNote } | { ok: false; reason: string } | { ok: false; reason: "not-a-note"; notANote: true }`.
  Use the simpler shape below — `{ kind: "note" | "other" | "malformed" }` — so callers switch once.

This task is pure string work with no Telegram in it. It is separated because the format is the one thing every later task depends on and the one thing a probe already proved fragile: teleproto's high-level send rewrote `**bold**` into `bold`. The round-trip test below is the regression guard for that finding.

- [ ] **Step 1: Write the failing test**

```ts
// tests/telegram-source-notes.test.ts
import { describe, expect, it } from "vitest";
import {
  noteMarker,
  parseNoteMessage,
  serializeNote,
} from "@/telegram/source-notes";
import type { SourceNote } from "@/schemas/source-note";

const note: SourceNote = {
  id: "-1002222222222",
  handle: "@examplechannel",
  title: "My **Cosmos**",
  about: "Covers `launches` and _orbital_ mechanics, with **original** photos.",
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/telegram-source-notes.test.ts`
Expected: FAIL — cannot resolve `@/telegram/source-notes`.

- [ ] **Step 3: Write the implementation**

```ts
// src/telegram/source-notes.ts
import { sourceNoteSchema, type SourceNote } from "../schemas/source-note";

const MARKER_PREFIX = "gs:src:";

/**
 * The lookup key for one source's note.
 *
 * The leading minus of a marked id is dropped because it is punctuation to
 * Telegram's search tokenizer, and search is how a note is found: there is no
 * index message and a message id is not a durable handle (a probe on
 * 2026-08-29 read a deleted id and got a different object back). The signed id
 * survives inside the JSON, where it is the field every other tool joins on.
 */
export function noteMarker(sourceId: string): string {
  return `${MARKER_PREFIX}${sourceId.replace(/^-/, "")}`;
}

export type ParseOutcome =
  | { kind: "note"; note: SourceNote }
  | { kind: "other" }
  | { kind: "malformed"; reason: string };

export function serializeNote(note: SourceNote): string {
  return `${noteMarker(note.id)}\n${JSON.stringify(note)}`;
}

/**
 * Three outcomes, not two. `other` is a message that is not ours at all — the
 * `me` peer holds service messages, including one this account cannot delete —
 * and it is silently skipped. `malformed` is a message that claims to be a
 * note and is not, which is reported to the caller rather than skipped: a
 * corrupt note is a hole in the memory the agent should know about.
 */
export function parseNoteMessage(text: string): ParseOutcome {
  const newline = text.indexOf("\n");
  if (newline === -1) return { kind: "other" };
  const marker = text.slice(0, newline);
  if (!/^gs:src:\d+$/.test(marker)) return { kind: "other" };

  let payload: unknown;
  try {
    payload = JSON.parse(text.slice(newline + 1));
  } catch {
    return { kind: "malformed", reason: "body is not valid JSON" };
  }

  const parsed = sourceNoteSchema.safeParse(payload);
  if (!parsed.success) {
    return { kind: "malformed", reason: "body is not a source note" };
  }
  if (noteMarker(parsed.data.id) !== marker) {
    return {
      kind: "malformed",
      reason: "marker and note id disagree",
    };
  }
  return { kind: "note", note: parsed.data };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/telegram-source-notes.test.ts && npm run typecheck && npm run lint`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/source-notes.ts tests/telegram-source-notes.test.ts
git commit -m "feat: source note wire format"
```

---

### Task 3: Reading the store

**Files:**

- Modify: `src/pagination.ts` (add one cursor kind next to `PINNED_CURSOR_KIND`)
- Modify: `src/telegram/source-notes.ts`
- Modify: `tests/telegram-source-notes.test.ts`
- Modify: `tests/pagination.test.ts`

**Interfaces:**

- Consumes: `noteMarker`, `parseNoteMessage` (Task 2); `withTelegram` from `src/telegram/client.ts`; `assertSourceIdsBounded`, `MAX_SOURCES_PER_CALL` from `src/telegram/source-selection.ts`; `scopeFingerprint`, `assertSameScope`, `OffsetCursor` from `src/pagination.ts`.
- Produces: `listSourceNotes(input: GetSourceNotesInput): Promise<GetSourceNotesResult>` and the two types, plus `encodeSourceNotesCursor` / `decodeSourceNotesCursor` / `SOURCE_NOTES_CURSOR_KIND` in `src/pagination.ts`.

```ts
export type GetSourceNotesInput = {
  source_ids?: string[];
  query?: string;
  limit?: number;
  cursor?: string;
};

export type GetSourceNotesResult = {
  notes: SourceNote[];
  duplicates: Array<{ source_id: string; message_ids: number[] }>;
  malformed: Array<{ message_id: number; reason: string }>;
  next_cursor?: string;
};
```

Two read paths. `source_ids` does one marker search per id, so asking about three sources costs three lookups instead of the whole store, and it returns everything it finds without a cursor — at most 25 notes cannot need a page. Everything else pages the peer newest-first through `offsetId`.

Telegram's search matches word prefixes, so a marker query can return a note whose id merely starts with the one asked for. Narrowing is search's job; exactness is the parser's: every hit is parsed and compared on `note.id` before it counts.

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/telegram-source-notes.test.ts
import { afterEach } from "vitest";
import { listSourceNotes } from "@/telegram/source-notes";
import {
  __resetClientForTests,
  __setClientFactoryForTests,
} from "@/telegram/client";

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
});
```

Add to `tests/pagination.test.ts`:

```ts
it("refuses a pinned cursor where a source-notes cursor is expected", () => {
  const foreign = encodePinnedCursor({ offsetId: 5, fingerprint: "f" });
  expect(() => decodeSourceNotesCursor(foreign)).toThrow(/another tool/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/telegram-source-notes.test.ts tests/pagination.test.ts`
Expected: FAIL — `listSourceNotes` and `decodeSourceNotesCursor` do not exist.

- [ ] **Step 3: Add the cursor kind**

In `src/pagination.ts`, beside the existing `PINNED_CURSOR_KIND` block:

```ts
export const SOURCE_NOTES_CURSOR_KIND = "source_notes";

export function encodeSourceNotesCursor(cursor: OffsetCursor): string {
  return encodeOffsetCursor(SOURCE_NOTES_CURSOR_KIND, cursor);
}

export function decodeSourceNotesCursor(raw: string): OffsetCursor {
  return decodeOffsetCursor(raw, SOURCE_NOTES_CURSOR_KIND);
}
```

Export it from wherever `encodePinnedCursor` is exported; the file has no barrel, so nothing else is needed.

- [ ] **Step 4: Write the read engine**

Append to `src/telegram/source-notes.ts`:

```ts
import { withTelegram, type TelegramLike } from "./client";
import {
  assertSameScope,
  decodeSourceNotesCursor,
  encodeSourceNotesCursor,
  scopeFingerprint,
} from "../pagination";
import {
  assertSourceIdsBounded,
  MAX_SOURCES_PER_CALL,
} from "./source-selection";

export const SAVED_PEER = "me";
export const DEFAULT_NOTES_LIMIT = 100;

export type GetSourceNotesInput = {
  source_ids?: string[];
  query?: string;
  limit?: number;
  cursor?: string;
};

export type GetSourceNotesResult = {
  notes: SourceNote[];
  duplicates: Array<{ source_id: string; message_ids: number[] }>;
  malformed: Array<{ message_id: number; reason: string }>;
  next_cursor?: string;
};

type RawMessage = { id: number; message?: unknown };

function textOf(message: RawMessage): string | undefined {
  return typeof message.message === "string" ? message.message : undefined;
}

async function fetchPage(
  client: TelegramLike,
  params: { limit: number; offsetId?: number; search?: string },
): Promise<RawMessage[]> {
  const page = (await client.getMessages(SAVED_PEER, {
    limit: params.limit,
    ...(params.offsetId ? { offsetId: params.offsetId } : {}),
    ...(params.search ? { search: params.search } : {}),
  })) as RawMessage[];
  // teleproto returns a TotalList, an Array subclass that survives map and
  // filter. Normalize before the value goes anywhere near a domain result.
  return Array.from(page);
}

/**
 * Collapses a page of raw messages into notes, duplicates and malformed
 * entries. Newest wins a duplicate: an interrupted delete-and-resend leaves
 * the older copy behind, and the newer one is what the last write intended.
 */
function collect(messages: RawMessage[]): {
  notes: SourceNote[];
  duplicates: GetSourceNotesResult["duplicates"];
  malformed: GetSourceNotesResult["malformed"];
} {
  const byId = new Map<string, { note: SourceNote; ids: number[] }>();
  const malformed: GetSourceNotesResult["malformed"] = [];

  for (const message of [...messages].sort((a, b) => b.id - a.id)) {
    const text = textOf(message);
    if (text === undefined) continue;
    const outcome = parseNoteMessage(text);
    if (outcome.kind === "other") continue;
    if (outcome.kind === "malformed") {
      malformed.push({ message_id: message.id, reason: outcome.reason });
      continue;
    }
    const seen = byId.get(outcome.note.id);
    if (seen) seen.ids.push(message.id);
    else byId.set(outcome.note.id, { note: outcome.note, ids: [message.id] });
  }

  const duplicates: GetSourceNotesResult["duplicates"] = [];
  for (const [sourceId, entry] of byId) {
    if (entry.ids.length > 1) {
      duplicates.push({ source_id: sourceId, message_ids: entry.ids });
    }
  }

  return {
    notes: [...byId.values()].map((entry) => entry.note),
    duplicates,
    malformed,
  };
}

/** Every message carrying one source's marker, newest first. The marker
 *  narrows; the parse decides, because Telegram matches word prefixes and a
 *  longer id starts with a shorter one. */
export async function findNoteMessages(
  client: TelegramLike,
  sourceId: string,
): Promise<Array<{ id: number; note: SourceNote }>> {
  const page = await fetchPage(client, {
    limit: 20,
    search: noteMarker(sourceId),
  });
  const found: Array<{ id: number; note: SourceNote }> = [];
  for (const message of page) {
    const text = textOf(message);
    if (text === undefined) continue;
    const outcome = parseNoteMessage(text);
    if (outcome.kind === "note" && outcome.note.id === sourceId) {
      found.push({ id: message.id, note: outcome.note });
    }
  }
  return found.sort((a, b) => b.id - a.id);
}

export async function listSourceNotes(
  input: GetSourceNotesInput,
): Promise<GetSourceNotesResult> {
  if (input.source_ids) {
    assertSourceIdsBounded(
      input.source_ids,
      "get_source_notes",
      MAX_SOURCES_PER_CALL,
    );
  }

  return withTelegram(async (client) => {
    if (input.source_ids) {
      const notes: SourceNote[] = [];
      const duplicates: GetSourceNotesResult["duplicates"] = [];
      for (const sourceId of input.source_ids) {
        const found = await findNoteMessages(client, sourceId);
        if (found.length === 0) continue;
        notes.push(found[0]!.note);
        if (found.length > 1) {
          duplicates.push({
            source_id: sourceId,
            message_ids: found.map((entry) => entry.id),
          });
        }
      }
      return { notes, duplicates, malformed: [] };
    }

    const fingerprint = scopeFingerprint({ query: input.query });
    let offsetId = 0;
    if (input.cursor) {
      const cursor = decodeSourceNotesCursor(input.cursor);
      assertSameScope(cursor.fingerprint, fingerprint);
      offsetId = cursor.offsetId;
    }

    const limit = input.limit ?? DEFAULT_NOTES_LIMIT;
    const page = await fetchPage(client, {
      limit,
      ...(offsetId ? { offsetId } : {}),
      ...(input.query ? { search: input.query } : {}),
    });
    const collected = collect(page);
    const oldest = page.reduce(
      (min, message) => (min === 0 || message.id < min ? message.id : min),
      0,
    );

    return {
      ...collected,
      ...(page.length === limit && oldest > 0
        ? {
            next_cursor: encodeSourceNotesCursor({
              offsetId: oldest,
              fingerprint,
            }),
          }
        : {}),
    };
  });
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/telegram-source-notes.test.ts tests/pagination.test.ts && npm run typecheck && npm run lint`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add src/pagination.ts src/telegram/source-notes.ts tests/telegram-source-notes.test.ts tests/pagination.test.ts
git commit -m "feat: read source notes from Saved Messages"
```

---

### Task 4: Writing a note

**Files:**

- Modify: `src/telegram/source-notes.ts`
- Modify: `tests/telegram-source-notes.test.ts`

**Interfaces:**

- Consumes: `findNoteMessages`, `serializeNote` (Tasks 2–3); `assertNoteInputBounded`, `SourceNoteInput` (Task 1); `withTelegram`, `getApi`, `resolveEntity` from `src/telegram/client.ts`; `resolveSource` from `src/telegram/peer-resolve.ts`; `fetchDialogIndex` from `src/telegram/dialog-index.ts`.
- Produces: `setSourceNote(input: SetSourceNoteInput): Promise<SetSourceNoteResult>`.

```ts
export type SetSourceNoteInput = SourceNoteInput & { source_id: string };
export type SetSourceNoteResult = { note: SourceNote; replaced: boolean };
```

Three facts from the 2026-08-29 probe drive this code and must not be traded away:

1. `client.sendMessage` parses markdown and ate the asterisks of `**bold**`. Sending goes through raw `Api.messages.SendMessage` with no `entities`.
2. `editMessage` works on the account's own Saved Messages, but only a seconds-old message was tested, so Telegram's 48-hour edit window may still apply. Any edit failure falls back to delete-and-resend rather than failing the call.
3. A message id is not a durable handle. The result is re-read through `findNoteMessages` after the write, never assembled from the input.

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/telegram-source-notes.test.ts
import { setSourceNote } from "@/telegram/source-notes";

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
    invoke: async (request: Record<string, unknown>) => {
      sent.push(request);
      const name = request.className as string;
      if (name?.endsWith("SendMessage")) {
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

  it("rejects an over-long about before touching the network", async () => {
    const fake = writableFactory([]);
    __setClientFactoryForTests((async () => fake.client) as never);

    await expect(
      setSourceNote({ ...input, about: "x".repeat(301) }),
    ).rejects.toThrow(/300/);
    expect(fake.sent).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/telegram-source-notes.test.ts`
Expected: FAIL — `setSourceNote` does not exist.

- [ ] **Step 3: Write the implementation**

Append to `src/telegram/source-notes.ts`:

```ts
import { randomBytes } from "node:crypto";
import { getApi, resolveEntity } from "./client";
import { fetchDialogIndex } from "./dialog-index";
import { resolveSource } from "./peer-resolve";
import {
  assertNoteInputBounded,
  type SourceNoteInput,
} from "../schemas/source-note";

export type SetSourceNoteInput = SourceNoteInput & { source_id: string };
export type SetSourceNoteResult = { note: SourceNote; replaced: boolean };

/** Telegram wants a 64-bit client-side id to deduplicate a retried send. */
function randomId(): bigint {
  return BigInt.asIntN(64, BigInt(`0x${randomBytes(8).toString("hex")}`));
}

async function sendNote(
  client: TelegramLike,
  peer: unknown,
  text: string,
): Promise<void> {
  const Api = await getApi();
  // Raw, not client.sendMessage: the high-level call applies markdown parsing
  // and a probe on 2026-08-29 watched it turn `**bold**` into `bold`. A note
  // store that rewrites its own payload is worse than none.
  await client.invoke(
    new Api.messages.SendMessage({
      peer: peer as never,
      message: text,
      randomId: randomId() as never,
      noWebpage: true,
    }),
  );
}

async function deleteMessages(
  client: TelegramLike,
  ids: number[],
): Promise<void> {
  if (ids.length === 0) return;
  const Api = await getApi();
  await client.invoke(
    new Api.messages.DeleteMessages({ id: ids, revoke: true }),
  );
}

export async function setSourceNote(
  input: SetSourceNoteInput,
): Promise<SetSourceNoteResult> {
  assertNoteInputBounded(input);

  const index = await fetchDialogIndex();
  return withTelegram(async (client) => {
    const Api = await getApi();
    const source = await resolveSource(client, index, input.source_id);
    const peer = await resolveEntity(client, SAVED_PEER);

    const note: SourceNote = {
      id: source.source_id,
      ...(source.username ? { handle: `@${source.username}` } : {}),
      title: source.title,
      about: input.about,
      topics: input.topics,
      kind: input.kind,
      ...(input.lang ? { lang: input.lang } : {}),
      ...(input.cadence ? { cadence: input.cadence } : {}),
      ...(input.derived_from ? { derived_from: input.derived_from } : {}),
      updated: new Date().toISOString().slice(0, 10),
    };
    const text = serializeNote(note);

    const existing = await findNoteMessages(client, note.id);
    const newest = existing[0];

    if (newest) {
      let edited = false;
      try {
        await client.invoke(
          new Api.messages.EditMessage({
            peer: peer as never,
            id: newest.id,
            message: text,
            noWebpage: true,
          }),
        );
        edited = true;
      } catch {
        // The probe could only edit a seconds-old message, so Telegram's edit
        // window may well apply here. Delete-and-resend is then the update
        // path, not an error case.
        await deleteMessages(client, [newest.id]);
      }
      if (!edited) await sendNote(client, peer, text);
      // Extras can only come from an interrupted delete-and-resend. This call
      // is already overwriting this source's note, so collapsing them is
      // within its job; a read path would never delete them.
      await deleteMessages(
        client,
        existing.slice(1).map((entry) => entry.id),
      );
    } else {
      await sendNote(client, peer, text);
    }

    // Re-read rather than echo the input: what is worth confirming is what the
    // store now holds, not what the caller meant.
    const stored = await findNoteMessages(client, note.id);
    if (stored.length === 0) {
      throw new GramScopeError(
        "INTERNAL_ERROR",
        "The note was written but could not be read back",
      );
    }
    return { note: stored[0]!.note, replaced: existing.length > 0 };
  });
}
```

Add `import { GramScopeError } from "../errors/taxonomy";` to the file's imports.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/telegram-source-notes.test.ts && npm run typecheck && npm run lint`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/source-notes.ts tests/telegram-source-notes.test.ts
git commit -m "feat: write a source note with edit and resend fallback"
```

---

### Task 5: Deleting a note

**Files:**

- Modify: `src/telegram/source-notes.ts`
- Modify: `tests/telegram-source-notes.test.ts`

**Interfaces:**

- Consumes: `findNoteMessages`, `resolveSource`, `fetchDialogIndex`.
- Produces: `deleteSourceNote(sourceId: string): Promise<{ deleted: boolean }>`.

Absence is not an error. Deleting a note that was never written reports `deleted: false`, the same shape `leave_channel` uses for `was_member`.

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/telegram-source-notes.test.ts
import { deleteSourceNote } from "@/telegram/source-notes";

describe("deleteSourceNote", () => {
  it("deletes every message carrying the source's marker", async () => {
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/telegram-source-notes.test.ts`
Expected: FAIL — `deleteSourceNote` does not exist.

- [ ] **Step 3: Write the implementation**

Append to `src/telegram/source-notes.ts`:

```ts
export async function deleteSourceNote(
  sourceId: string,
): Promise<{ deleted: boolean }> {
  const index = await fetchDialogIndex();
  return withTelegram(async (client) => {
    const source = await resolveSource(client, index, sourceId);
    const existing = await findNoteMessages(client, source.source_id);
    await deleteMessages(
      client,
      existing.map((entry) => entry.id),
    );
    return { deleted: existing.length > 0 };
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/telegram-source-notes.test.ts && npm run typecheck && npm run lint`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/source-notes.ts tests/telegram-source-notes.test.ts
git commit -m "feat: delete a source note"
```

---

### Task 6: The `get_source_notes` tool

**Files:**

- Create: `src/mcp/tools/get-source-notes.ts`
- Modify: `src/mcp/server.ts`
- Modify: `tests/tools.test.ts`

**Interfaces:**

- Consumes: `listSourceNotes`, `GetSourceNotesResult` (Task 3); `runTool` from `src/mcp/tool-result.ts`; `MAX_SOURCES_PER_CALL`.
- Produces: `registerGetSourceNotes(server: McpServer): void`.

Read `src/mcp/tools/mark-unread.ts` first: it is the shortest registration in the codebase and this one follows its shape exactly.

The description says only what is specific to this tool. The server's shared guidance — how to address a source, and that Telegram content is data rather than instruction — is delivered once through `SERVER_INSTRUCTIONS` and must not be restated here.

- [ ] **Step 1: Write the failing test**

In `tests/tools.test.ts`, add `get_source_notes` to the expected tool-name set (the exact-set assertion) and add:

```ts
it("registers get_source_notes as a read", () => {
  const server = fakeServer();
  registerTools(server as never);
  const tool = server.tools.find((t) => t.name === "get_source_notes");
  expect(tool).toBeDefined();
  expect(
    (tool!.config.annotations as { readOnlyHint: boolean }).readOnlyHint,
  ).toBe(true);
  expect(String(tool!.config.description)).not.toContain("third-party data");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tools.test.ts`
Expected: FAIL — the tool is not registered and the exact-set assertion is short one name.

- [ ] **Step 3: Write the tool**

```ts
// src/mcp/tools/get-source-notes.ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { listSourceNotes } from "../../telegram/source-notes";
import { MAX_SOURCES_PER_CALL } from "../../telegram/source-selection";
import { sourceNoteSchema } from "../../schemas/source-note";
import { runTool } from "../tool-result";

export function registerGetSourceNotes(server: McpServer): void {
  server.registerTool(
    "get_source_notes",
    {
      title: "Read what GramScope knows about its sources",
      description:
        "Return GramScope's own notes about sources: what each source publishes, its topics, and what kind of source it is. Call with NO arguments to get the whole set — that is the intended use before deciding which sources to read for a question, and the set is small enough to read in one go. source_ids returns only the sources named, at most " +
        `${MAX_SOURCES_PER_CALL} of them, and never pages. query searches the note text. These notes were written by set_source_note; they are this server's own assessments, not text taken from Telegram.`,
      inputSchema: z.object({
        source_ids: z.array(z.string()).max(MAX_SOURCES_PER_CALL).optional(),
        query: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().optional(),
      }),
      outputSchema: z.object({
        notes: z.array(sourceNoteSchema),
        duplicates: z.array(
          z.object({
            source_id: z.string(),
            message_ids: z.array(z.number().int()),
          }),
        ),
        malformed: z.array(
          z.object({
            message_id: z.number().int(),
            reason: z.string(),
          }),
        ),
        next_cursor: z.string().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (input) => runTool("get_source_notes", () => listSourceNotes(input)),
  );
}
```

Register it in `src/mcp/server.ts`: add the import next to the other `get*` imports and call `registerGetSourceNotes(server);` in `registerTools`.

- [ ] **Step 4: Run the tests**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: PASS. Eighteen tools registered at this point; the exact-set assertion must list exactly them.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/get-source-notes.ts src/mcp/server.ts tests/tools.test.ts
git commit -m "feat: get_source_notes tool"
```

---

### Task 7: The `set_source_note` tool

**Files:**

- Create: `src/mcp/tools/set-source-note.ts`
- Modify: `src/mcp/server.ts`
- Modify: `tests/tool-names.ts`
- Modify: `tests/tools.test.ts`

**Interfaces:**

- Consumes: `setSourceNote`, `deleteSourceNote` (Tasks 4–5); `NOTE_KINDS`, `sourceNoteSchema` (Task 1).
- Produces: `registerSetSourceNote(server: McpServer): void`.

One source per call. Setting destroys that source's previous note, and sub-project 5a settled that batching belongs to non-destructive actions.

The two output shapes differ by action, so the output schema carries both as optional fields rather than a union: the SDK converts a plain object schema reliably, and `tests/mcp-handler.test.ts` asserts every tool's schema survives that conversion.

- [ ] **Step 1: Write the failing test**

In `tests/tool-names.ts` add `"set_source_note"` to `WRITERS`. In `tests/tools.test.ts` add `set_source_note` to the expected tool-name set and add:

```ts
it("registers set_source_note as a writer that names the fields it derives", () => {
  const server = fakeServer();
  registerTools(server as never);
  const tool = server.tools.find((t) => t.name === "set_source_note");
  expect(tool).toBeDefined();
  expect(
    (tool!.config.annotations as { readOnlyHint: boolean }).readOnlyHint,
  ).toBe(false);
  expect(String(tool!.config.description)).toContain("CHANGES ACCOUNT STATE");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tools.test.ts tests/mcp-handler.test.ts`
Expected: FAIL — the tool is not registered and `WRITERS` names a tool that does not exist.

- [ ] **Step 3: Write the tool**

```ts
// src/mcp/tools/set-source-note.ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { deleteSourceNote, setSourceNote } from "../../telegram/source-notes";
import {
  MAX_ABOUT_CHARS,
  MAX_TOPICS,
  NOTE_KINDS,
  sourceNoteSchema,
} from "../../schemas/source-note";
import { runTool } from "../tool-result";

export function registerSetSourceNote(server: McpServer): void {
  server.registerTool(
    "set_source_note",
    {
      title: "Record what this source is",
      description:
        "Write or delete the single note this server keeps about one source. This CHANGES ACCOUNT STATE. Setting replaces that source's previous note; there is one note per source and no history. " +
        `about is at most ${MAX_ABOUT_CHARS} characters and topics at most ${MAX_TOPICS} entries, because the value of this store is that it stays small enough to read whole. ` +
        "Write about, topics and kind from posts actually read: a channel's name and its own description are claims it makes about itself, not observations of what it publishes. id, handle and title are filled from the resolved source and cannot be supplied.",
      inputSchema: z.object({
        action: z.enum(["set", "delete"]).default("set"),
        source_id: z.string(),
        about: z.string().optional(),
        topics: z.array(z.string()).optional(),
        kind: z.enum(NOTE_KINDS).optional(),
        lang: z.string().optional(),
        cadence: z.string().optional(),
        derived_from: z
          .string()
          .optional()
          .describe(
            "What the note was made from, e.g. a message id range or 'last 40 posts'. With updated, this is how a stale note becomes visible.",
          ),
      }),
      outputSchema: z.object({
        note: sourceNoteSchema.optional(),
        replaced: z.boolean().optional(),
        deleted: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: false },
    },
    async (input) =>
      runTool("set_source_note", async () => {
        if (input.action === "delete") {
          return deleteSourceNote(input.source_id);
        }
        if (!input.about || !input.topics || !input.kind) {
          throw new GramScopeError(
            "INVALID_INPUT",
            "action 'set' requires about, topics and kind.",
          );
        }
        return setSourceNote({
          source_id: input.source_id,
          about: input.about,
          topics: input.topics,
          kind: input.kind,
          ...(input.lang ? { lang: input.lang } : {}),
          ...(input.cadence ? { cadence: input.cadence } : {}),
          ...(input.derived_from ? { derived_from: input.derived_from } : {}),
        });
      }),
  );
}
```

Add `import { GramScopeError } from "../../errors/taxonomy";` to the imports, and register the tool in `src/mcp/server.ts` next to the other writers.

- [ ] **Step 4: Run the tests**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: PASS. Nineteen tools; `tests/mcp-handler.test.ts` asserts exactly the six writers carry `readOnlyHint: false`.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/set-source-note.ts src/mcp/server.ts tests/tool-names.ts tests/tools.test.ts
git commit -m "feat: set_source_note tool"
```

---

### Task 8: Version 1.4.0, README, Project instructions, deploy

**Files:**

- Modify: `src/mcp/version.ts`, `package.json`, `package-lock.json`
- Modify: `README.md`
- Modify: `docs/chatgpt-project-instructions.md`

Sub-project 5a's review established that both root version fields are part of the tested version invariant, so `package-lock.json` moves with `package.json`; removing the assertion instead was rejected there and is rejected here.

`docs/chatgpt-project-instructions.md` is **live prompt text of a ChatGPT Project that already exists**. Editing it changes what the owner must re-paste. The file marks the region that belongs in the Project — everything from `## What this connector is` downwards — and that boundary stays intact.

- [ ] **Step 1: Move the version**

Set `1.4.0` in `src/mcp/version.ts` (`MCP_SERVER_VERSION`), in `package.json`, and in both root version fields of `package-lock.json`.

- [ ] **Step 2: Run the version tests**

Run: `npm run test`
Expected: PASS — the invariant tests pin all three.

- [ ] **Step 3: Rewrite the stale README sections**

Delete or rewrite every place the README promises work that will not exist:

- `#### save_message`, `#### get_saved_messages`, `#### search_saved_messages` — replaced by `set_source_note` and `get_source_notes`.
- `#### get_channel_note`, `#### set_channel_note` and the `### Source notes = private Telegram metadata channel` section — there is no `Source Meta` channel; Saved Messages is the store.
- `### Saved Messages = saved items` — Saved Messages hold GramScope's own notes about sources, never forwarded posts.
- The roadmap lines naming sub-project 5b's three tools and sub-project 6 — 5b is the last sub-project.
- Any tool count — nineteen.

Document the two new tools in the same shape as the existing entries, including the caps and the `kind` enum.

- [ ] **Step 4: Update the ChatGPT Project instructions**

Add the two tools to `docs/chatgpt-project-instructions.md` inside the pasteable region, saying what the store is for — a compact routing table written from what was read — and that notes are the server's own assessments rather than Telegram content. Keep the region boundary and the file's existing structure.

- [ ] **Step 5: Full gates**

Run: `npm run test && npm run typecheck && npm run lint && npm run build`
Expected: all green.

- [ ] **Step 6: Commit and deploy**

```bash
git add -A
git commit -m "chore: version 1.4.0, nineteen tools"
git push
```

Vercel deploys `main` on push. After the deploy finishes, confirm production reports 1.4.0 and that the protected-resource document and the `401` Bearer challenge still answer as they did in 5a.

- [ ] **Step 7: Hand the Project instructions to the owner**

Tell the owner the pasteable region changed and that the ChatGPT Project needs a re-paste. Do not claim the connector is accepted until they have done it.

---

### Task 9: The live tier

**Files:**

- Create: `tests/live/source-notes.live.test.ts`

The live suite runs its files sequentially — `fileParallelism: process.env.GRAMSCOPE_LIVE !== "1"` in `vitest.config.ts` — because every file mutates the same real account. Do not mark anything in this file `describe.concurrent`.

**The account's baseline for Saved Messages is zero notes.** It also holds one undeletable `MessageActionHistoryClear` service message, which the marker filter skips. This file must leave the peer holding zero notes whether it passes or fails.

- [ ] **Step 1: Write the live test**

```ts
// tests/live/source-notes.live.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  deleteSourceNote,
  listSourceNotes,
  setSourceNote,
} from "@/telegram/source-notes";
import { listDialogs } from "@/telegram/dialogs";

const enabled = process.env.GRAMSCOPE_LIVE === "1";
const suite = enabled ? describe : describe.skip;

suite("source notes against the real account", () => {
  let target = "";

  beforeAll(async () => {
    if (!process.env.TELEGRAM_SESSION) {
      throw new Error("TELEGRAM_SESSION is required for live tests");
    }
    const { sources } = await listDialogs({ limit: 5, type: "channel" });
    if (sources.length === 0) throw new Error("the account follows no channel");
    target = sources[0]!.id;
  });

  // Runs even if an expectation failed mid-file: the next live run must start
  // from the same baseline this one did.
  afterAll(async () => {
    if (target) await deleteSourceNote(target);
  });

  it("writes, reads, searches, overwrites and deletes one note", async () => {
    const written = await setSourceNote({
      source_id: target,
      about: "Live-tier probe note. **Not** parsed as markdown.",
      topics: ["gramscope-live-probe"],
      kind: "mixed",
      derived_from: "live test",
    });
    expect(written.replaced).toBe(false);
    expect(written.note.about).toContain("**Not**");
    expect(written.note.id).toBe(target);

    const all = await listSourceNotes({});
    expect(all.notes.map((n) => n.id)).toContain(target);
    expect(all.malformed).toEqual([]);
    expect(all.duplicates).toEqual([]);

    const byId = await listSourceNotes({ source_ids: [target] });
    expect(byId.notes).toHaveLength(1);

    const found = await listSourceNotes({ query: "gramscope-live-probe" });
    expect(found.notes.map((n) => n.id)).toContain(target);

    const again = await setSourceNote({
      source_id: target,
      about: "Rewritten by the live tier.",
      topics: ["gramscope-live-probe"],
      kind: "reporting",
    });
    expect(again.replaced).toBe(true);
    expect(again.note.about).toBe("Rewritten by the live tier.");

    const afterOverwrite = await listSourceNotes({ source_ids: [target] });
    expect(afterOverwrite.notes).toHaveLength(1);
    expect(afterOverwrite.duplicates).toEqual([]);

    const removed = await deleteSourceNote(target);
    expect(removed.deleted).toBe(true);

    const empty = await listSourceNotes({});
    expect(empty.notes.map((n) => n.id)).not.toContain(target);
  });

  it("reports deleting a note that is not there without failing", async () => {
    const result = await deleteSourceNote(target);
    expect(result.deleted).toBe(false);
  });

  it("leaves Saved Messages holding no notes", async () => {
    const result = await listSourceNotes({});
    expect(result.notes).toEqual([]);
    expect(result.malformed).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the live tier**

Run: `npm run test:live`
Expected: every file passes, including the five earlier live files. Note the pass/skip counts in the commit message the way earlier tasks did.

- [ ] **Step 3: Confirm the account is at baseline**

Run `npm run test:live` a second time. A file that leaks state passes once and fails on the repeat; this is the cheapest check that it does not.

- [ ] **Step 4: Commit**

```bash
git add tests/live/source-notes.live.test.ts
git commit -m "test: live tier for source notes"
git push
```

---

## Acceptance

The spec's §12 is the gate. After Task 9:

1. `npm run test`, `npm run typecheck`, `npm run lint`, `npm run build` green.
2. `npm run test:live` green twice in a row, Saved Messages left holding no notes.
3. Production serves 1.4.0 and lists nineteen tools.
4. The owner runs the connector sequence in §12.4 of the spec from ChatGPT.
5. The README names none of the five superseded tools and describes no `Source Meta` channel.
