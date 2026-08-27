# GramScope Research (sub-project 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship four research tools — `search_messages`, `get_thread`, `resolve_telegram_url`, `get_pinned_messages` — and teach the existing reading tools to accept sources the account has not joined, taking the server to eleven tools.

**Architecture:** A new `peer-resolve.ts` is the single place that knows the three ways to name a source (marked id, `@username`, `t.me` URL) and the single place that memoizes resolutions for the life of a serverless instance. Every new engine module — `search.ts`, `thread.ts`, `resolve.ts`, `pinned.ts` — resolves its peers there, invokes raw TL requests through the existing `withTelegram` boundary, and maps results with the existing `mapMessage`. Four new cursor kinds join the generic envelope in `src/pagination.ts`, each carrying a scope fingerprint so a cursor replayed against a changed query, a different post, or a different source is rejected instead of silently answering a different question.

**Tech Stack:** TypeScript, Next.js App Router on Vercel, `@modelcontextprotocol/server` + `mcp-handler`, `teleproto` v1.229.0 (MTProto), `zod` v4, `vitest`.

**Spec:** `docs/superpowers/specs/2026-08-27-gramscope-research-design.md`

**Card:** `docs/superpowers/tasks/gramscope-mcp.md`

## Global Constraints

- **Branch `main`.** The owner works directly on `main` until the project is fully launched. Do not create a branch. A push to `main` deploys to Vercel, so push only where the plan says to.
- **`src/telegram/client.ts` is the only module permitted to import `teleproto`.** Reach MTProto through `withTelegram(fn)` and the TL namespace through `await getApi()`. No other file may `import ... from "teleproto"`.
- **Never print or log the StringSession, the api hash, or any credential.** Secrets live in the gitignored `.env.local` locally and in `vercel env` for deploys; they never enter chat, commits, specs, plans, or test fixtures.
- **`channels.getFullChannel` is never fanned out.** At most one call per tool invocation, and only in `resolve_telegram_url` and the existing `get_channel`. It floods after roughly 20 calls with a 27-second wait that teleproto absorbs by sleeping, so a fan-out over it does not fail — it silently consumes the whole request budget.
- **Normalize teleproto arrays with `Array.from` before they enter a returned value.** `getDialogs` and `getMessages` return a `TotalList` (an `Array` subclass carrying `total`) and `filter`/`map`/`slice` preserve the subclass through `Symbol.species`.
- **Response cap: `MAX_RESPONSE_BYTES` = 256 KB**, enforced with the existing `fitToSizeCap`.
- **Fan-out ceiling: `MAX_SOURCES_PER_CALL` = 25, concurrency `FANOUT_CONCURRENCY` = 8**, both already exported.
- **Every cursor is opaque.** Its parameter description must repeat, verbatim in substance, the wording `get_messages` uses: copy it back exactly as received, character for character; it is not human-readable and must not be shortened, re-typed or reconstructed.
- **An empty result is never an error.** No hits, no comments and no pinned messages are all empty successes.
- **Gates for every task:** `npm run test`, `npm run typecheck`, `npm run lint` must be green before the commit. `npm run test` excludes the live tier by design.
- **`npm run build` rewrites `tsconfig.json`** (Next adds `allowJs`, `incremental`, `resolveJsonModule`, `isolatedModules` and reformats it). That is local churn — revert it, never commit it.
- **Test imports use the `@/` alias** for `src/` (`import { getMessages } from "@/telegram/messages"`).

---

## File Structure

Created:

| File | Responsibility |
| --- | --- |
| `src/telegram/peer-resolve.ts` | Parse the three source-name forms; resolve one to a peer; memoize for the instance lifetime. The only module that knows the difference between them. |
| `src/telegram/tl-messages.ts` | Read the three TL result shapes (`messages.Messages`, `messages.MessagesSlice`, `messages.ChannelMessages`) into one flat page type. Shared by search, thread and pinned so each does not re-derive it. |
| `src/telegram/search.ts` | Both search engines, the date merge, the roll-up, the budget. |
| `src/telegram/thread.ts` | The post pre-check and the comment page. |
| `src/telegram/resolve.ts` | Telegram URL parsing and entity resolution. |
| `src/telegram/pinned.ts` | Pinned-message page for one source. |
| `src/mcp/tools/search-messages.ts`, `get-thread.ts`, `resolve-telegram-url.ts`, `get-pinned-messages.ts` | Tool registration: schema, description, `readOnlyHint`. |
| `tests/telegram-peer-resolve.test.ts`, `tests/telegram-tl-messages.test.ts`, `tests/telegram-search.test.ts`, `tests/telegram-thread.test.ts`, `tests/telegram-resolve.test.ts`, `tests/telegram-pinned.test.ts` | Unit tests against a faked `TelegramLike`. |
| `tests/live/research.live.test.ts` | The live tier for this sub-project. |

Modified:

| File | Change |
| --- | --- |
| `src/pagination.ts` | Four new cursor kinds and `scopeFingerprint`. |
| `src/errors/taxonomy.ts` | `NO_DISCUSSION_THREAD`. |
| `src/telegram/message-slice.ts` | `SliceRequest.handle` — read a source by a handle that differs from its marked id. |
| `src/telegram/messages.ts` | Route every source name through `peer-resolve.ts`. |
| `src/telegram/dialogs.ts` | Export `fetchChannelDetails` so `resolve_telegram_url` reuses the single `getFullChannel` call site. |
| `src/mcp/server.ts` | Register the four new tools. |
| `src/mcp/tool-result.ts` | `countOf` prefers the flat `results` shape over the grouped `sources` shape. |
| `tests/mcp-handler.test.ts` | Eleven tools; `readOnlyHint` true on all four new ones. |

`tl-messages.ts` is not named in spec §12. It exists because three engines invoke TL requests that return the same union of three result shapes, and the alternative is the same twenty lines copied three times with three chances to disagree about where `count` lives.

---

<!-- TASKS BELOW ARE APPENDED AS THEY ARE WRITTEN; see the resume note at the end of the file. -->

### Task 1: Naming a source three ways

Spec §5. One module owns the difference between a marked id, a `@username` and
a `t.me` URL, and owns the per-instance memo of what each resolved to. Every
later task calls it; nothing else parses a source name.

**Files:**
- Create: `src/telegram/peer-resolve.ts`
- Test: `tests/telegram-peer-resolve.test.ts`

**Interfaces:**
- Consumes: `TelegramLike` and `withTelegram` from `src/telegram/client.ts`; `entityMarkedId` from `src/telegram/peer-id.ts`; `DialogIndex` from `src/telegram/dialog-index.ts`; `GramScopeError` from `src/errors/taxonomy.ts`.
- Produces:
  - `type TelegramLink = { kind: "username"; username: string; messageId?: number; commentId?: number } | { kind: "internal"; markedId: string; messageId?: number; commentId?: number } | { kind: "invite"; hash: string }`
  - `function parseTelegramName(raw: string): TelegramLink`
  - `type ResolvedSource = { source_id: string; title: string; username?: string; handle: string; entity?: Record<string, unknown> }`
  - `function resolveSource(client: TelegramLike, index: DialogIndex, raw: string): Promise<ResolvedSource>`
  - `function __resetPeerCacheForTests(): void`

`handle` is the value every later task hands to teleproto and stores in a
cursor: the username when the peer has one, the marked id otherwise. A bare
marked id is only a handle for peers the account already holds (card finding,
2026-08-27), so a channel that was resolved by username must keep travelling by
username or a cold serverless instance loses it.

- [ ] **Step 1: Write the failing test**

```ts
// tests/telegram-peer-resolve.test.ts
import { afterEach, describe, expect, it } from "vitest";
import {
  parseTelegramName,
  resolveSource,
  __resetPeerCacheForTests,
} from "@/telegram/peer-resolve";
import type { TelegramLike } from "@/telegram/client";
import { GramScopeError } from "@/errors/taxonomy";

const HELD = "-1001111111111";

function entry(id: string, title: string, username?: string) {
  return {
    source_id: id,
    title,
    ...(username !== undefined ? { username } : {}),
    unread_count: 0,
    read_inbox_max_id: 0,
    folder_ids: [] as string[],
  };
}

const index = {
  byId: new Map([[HELD, entry(HELD, "Held Channel", "held")]]),
  folders: [],
};

function client(entities: Record<string, Record<string, unknown>>) {
  const calls: string[] = [];
  const fake = {
    calls,
    connect: async () => true,
    invoke: async () => ({}),
    getDialogs: async () => [],
    getMessages: async () => [],
    getEntity: async (target: string) => {
      calls.push(target);
      const found = entities[target];
      if (!found) throw new Error("CHANNEL_INVALID");
      return found;
    },
  };
  return fake as unknown as TelegramLike & { calls: string[] };
}

afterEach(() => __resetPeerCacheForTests());

describe("parseTelegramName", () => {
  it("reads every form of a source name", () => {
    expect(parseTelegramName("-1001234567890")).toEqual({
      kind: "internal",
      markedId: "-1001234567890",
    });
    expect(parseTelegramName("@exampleuser")).toEqual({
      kind: "username",
      username: "exampleuser",
    });
    expect(parseTelegramName("exampleuser")).toEqual({
      kind: "username",
      username: "exampleuser",
    });
    expect(parseTelegramName("https://t.me/exampleuser")).toEqual({
      kind: "username",
      username: "exampleuser",
    });
    expect(parseTelegramName("t.me/s/exampleuser")).toEqual({
      kind: "username",
      username: "exampleuser",
    });
    expect(parseTelegramName("https://t.me/exampleuser/123")).toEqual({
      kind: "username",
      username: "exampleuser",
      messageId: 123,
    });
    expect(parseTelegramName("https://t.me/exampleuser/123?comment=456")).toEqual({
      kind: "username",
      username: "exampleuser",
      messageId: 123,
      commentId: 456,
    });
    expect(parseTelegramName("https://t.me/c/1234567890/55")).toEqual({
      kind: "internal",
      markedId: "-1001234567890",
      messageId: 55,
    });
    expect(parseTelegramName("https://t.me/+AbCdEf")).toEqual({
      kind: "invite",
      hash: "AbCdEf",
    });
    expect(parseTelegramName("https://t.me/joinchat/AbCdEf")).toEqual({
      kind: "invite",
      hash: "AbCdEf",
    });
  });

  it("rejects what is not a source name", () => {
    for (const bad of ["", "   ", "https://example.com/exampleuser", "a b c"]) {
      expect(() => parseTelegramName(bad), bad).toThrow(GramScopeError);
    }
  });
});

describe("resolveSource", () => {
  it("answers from the dialog index without a round trip", async () => {
    const fake = client({});
    const resolved = await resolveSource(fake, index, HELD);
    expect(resolved).toEqual({
      source_id: HELD,
      title: "Held Channel",
      username: "held",
      handle: "held",
    });
    expect(fake.calls).toEqual([]);
  });

  it("matches an index entry by its username too", async () => {
    const fake = client({});
    expect((await resolveSource(fake, index, "@Held")).source_id).toBe(HELD);
    expect(fake.calls).toEqual([]);
  });

  it("resolves an outside channel by username and keeps it as the handle", async () => {
    const fake = client({
      outside: { className: "Channel", id: 999n, title: "Outside", username: "outside" },
    });
    const resolved = await resolveSource(fake, index, "https://t.me/outside");
    expect(resolved).toEqual({
      source_id: "-100999",
      title: "Outside",
      username: "outside",
      handle: "outside",
      entity: {
        className: "Channel",
        id: 999n,
        title: "Outside",
        username: "outside",
      },
    });
    expect(fake.calls).toEqual(["outside"]);
  });

  it("memoizes a resolution for the life of the instance", async () => {
    const fake = client({
      outside: { className: "Channel", id: 999n, title: "Outside", username: "outside" },
    });
    await resolveSource(fake, index, "@outside");
    await resolveSource(fake, index, "https://t.me/outside/17");
    expect(fake.calls).toEqual(["outside"]);
  });

  it("refuses an invite link as a source name", async () => {
    const fake = client({});
    await expect(resolveSource(fake, index, "t.me/+AbCdEf")).rejects.toThrow(
      /resolve_telegram_url/,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/telegram-peer-resolve.test.ts`
Expected: FAIL — `Failed to resolve import "@/telegram/peer-resolve"`.

- [ ] **Step 3: Write the implementation**

```ts
// src/telegram/peer-resolve.ts
import type { TelegramLike } from "./client";
import type { DialogIndex } from "./dialog-index";
import { entityMarkedId } from "./peer-id";
import { GramScopeError } from "../errors/taxonomy";

/**
 * Spec §5. A source may be named three ways and this module is the only one
 * that knows the difference. Everything else takes a ResolvedSource.
 */
export type TelegramLink =
  | {
      kind: "username";
      username: string;
      messageId?: number;
      commentId?: number;
    }
  | {
      kind: "internal";
      markedId: string;
      messageId?: number;
      commentId?: number;
    }
  | { kind: "invite"; hash: string };

const USERNAME = /^[A-Za-z0-9_]{4,32}$/;
const MARKED_ID = /^-?\d{1,20}$/;
const TME = /^(?:https?:\/\/)?(?:www\.)?t\.me\/(.+)$/i;

function messageIds(
  rest: string[],
  query: string,
): { messageId?: number; commentId?: number } {
  // A forum topic link is t.me/name/<topic>/<msg>, so the LAST numeric
  // segment is the message; ?comment= names a comment under it.
  const numeric = rest.filter((part) => /^\d+$/.test(part)).map(Number);
  const comment = /[?&]comment=(\d+)/.exec(query);
  return {
    ...(numeric.length > 0 ? { messageId: numeric[numeric.length - 1]! } : {}),
    ...(comment ? { commentId: Number(comment[1]) } : {}),
  };
}

export function parseTelegramName(raw: string): TelegramLink {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new GramScopeError("INVALID_INPUT", "A source name cannot be empty");
  }

  const url = TME.exec(trimmed);
  if (url) {
    const [path, query = ""] = url[1]!.split("?", 2) as [string, string?];
    const parts = path.split("/").filter((part) => part.length > 0);
    const first = parts[0]!;

    if (first.startsWith("+")) {
      return { kind: "invite", hash: first.slice(1) };
    }
    if (first === "joinchat" && parts[1]) {
      return { kind: "invite", hash: parts[1] };
    }
    // t.me/c/<internal>/<msg> — a private peer addressed by its BARE id.
    if (first === "c" && parts[1] && /^\d+$/.test(parts[1])) {
      return {
        kind: "internal",
        markedId: `-100${parts[1]}`,
        ...messageIds(parts.slice(2), `?${query}`),
      };
    }
    // t.me/s/<name> is the public web preview of the same channel.
    const rest = first === "s" ? parts.slice(1) : parts;
    const name = rest[0];
    if (!name || !USERNAME.test(name)) {
      throw new GramScopeError(
        "INVALID_INPUT",
        `Unrecognized Telegram URL: ${trimmed}`,
      );
    }
    return {
      kind: "username",
      username: name,
      ...messageIds(rest.slice(1), `?${query}`),
    };
  }

  if (MARKED_ID.test(trimmed)) {
    return { kind: "internal", markedId: trimmed };
  }

  const bare = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  if (USERNAME.test(bare)) return { kind: "username", username: bare };

  throw new GramScopeError(
    "INVALID_INPUT",
    `Not a Telegram source name: ${trimmed}. Use a marked id like -1001234567890, a @username, or a t.me link.`,
  );
}

export type ResolvedSource = {
  /** Marked id — what every response reports as source_id. */
  source_id: string;
  title: string;
  username?: string;
  /**
   * What to hand to teleproto and what a cursor stores. A bare marked id
   * resolves only for peers the account holds, so a channel found by username
   * must keep travelling by username across cold instances.
   */
  handle: string;
  /** Present only when resolution went over the network. */
  entity?: Record<string, unknown>;
};

// Module scope, like the client itself: a warm Vercel instance keeps this
// between invocations, which is the whole saving.
const cache = new Map<string, ResolvedSource>();

export function __resetPeerCacheForTests(): void {
  cache.clear();
}

export async function resolveSource(
  client: TelegramLike,
  index: DialogIndex,
  raw: string,
): Promise<ResolvedSource> {
  const link = parseTelegramName(raw);
  if (link.kind === "invite") {
    throw new GramScopeError(
      "INVALID_INPUT",
      "An invite link is not a readable source. Call resolve_telegram_url to preview it; joining is not supported yet.",
    );
  }

  const key =
    link.kind === "username"
      ? `u:${link.username.toLowerCase()}`
      : `i:${link.markedId}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const held =
    link.kind === "internal"
      ? index.byId.get(link.markedId)
      : [...index.byId.values()].find(
          (candidate) =>
            candidate.username?.toLowerCase() === link.username.toLowerCase(),
        );

  if (held) {
    const resolved: ResolvedSource = {
      source_id: held.source_id,
      title: held.title,
      ...(held.username !== undefined ? { username: held.username } : {}),
      handle: held.username ?? held.source_id,
    };
    cache.set(key, resolved);
    return resolved;
  }

  const target =
    link.kind === "username" ? link.username : link.markedId;
  const entity = await client.getEntity(target);
  const markedId = entityMarkedId(entity);
  if (markedId === undefined) {
    throw new GramScopeError(
      "CHANNEL_NOT_FOUND",
      `Could not resolve ${raw} to a Telegram peer`,
    );
  }

  const username =
    typeof entity.username === "string" ? entity.username : undefined;
  const title =
    typeof entity.title === "string"
      ? entity.title
      : typeof entity.firstName === "string"
        ? entity.firstName
        : markedId;

  const resolved: ResolvedSource = {
    source_id: markedId,
    title,
    ...(username !== undefined ? { username } : {}),
    handle: username ?? markedId,
    entity,
  };
  cache.set(key, resolved);
  return resolved;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/telegram-peer-resolve.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Run the gates**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: all green, and the pre-existing suite unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/telegram/peer-resolve.ts tests/telegram-peer-resolve.test.ts
git commit -m "feat: resolve a source named by id, username or t.me URL"
```

---

### Task 2: Four cursor kinds and the scope fingerprint

Spec §8, as amended during planning. Every new paginated tool gets its own
discriminator, and every cursor over a filtered result set carries a hash of
what defined that result set, so replaying it against a changed query is
rejected instead of silently answering a different question.

**Files:**
- Modify: `src/pagination.ts` (append after `decodeMessageCursor`)
- Test: `tests/pagination.test.ts` (append)

**Interfaces:**
- Consumes: the existing private `encodePayload` / `decodePayload` helpers and `CURSOR_VERSION` in the same file.
- Produces:
  - `function scopeFingerprint(parts: Record<string, unknown>): string`
  - `function assertSameScope(found: string, expected: string): void`
  - `type SearchGlobalCursor = { rate: number; peer: string; id: number; fingerprint: string }` with `encodeSearchGlobalCursor` / `decodeSearchGlobalCursor`
  - `type SearchSourcesCursor = { sources: Array<{ handle: string; offsetId: number }>; fingerprint: string }` with `encodeSearchSourcesCursor` / `decodeSearchSourcesCursor`
  - `type OffsetCursor = { offsetId: number; fingerprint: string }` with `encodeThreadCursor` / `decodeThreadCursor` and `encodePinnedCursor` / `decodePinnedCursor`

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/pagination.test.ts
import {
  assertSameScope,
  decodePinnedCursor,
  decodeSearchGlobalCursor,
  decodeSearchSourcesCursor,
  decodeThreadCursor,
  encodePinnedCursor,
  encodeSearchGlobalCursor,
  encodeSearchSourcesCursor,
  encodeThreadCursor,
  scopeFingerprint,
} from "@/pagination";

describe("scopeFingerprint", () => {
  it("ignores key order and absent filters", () => {
    expect(scopeFingerprint({ q: "x", from: undefined })).toBe(
      scopeFingerprint({ from: undefined, q: "x" }),
    );
    expect(scopeFingerprint({ q: "x" })).toBe(
      scopeFingerprint({ q: "x", to: undefined }),
    );
  });

  it("changes when any filter changes", () => {
    const base = scopeFingerprint({ q: "x", sources: ["-1001"] });
    expect(scopeFingerprint({ q: "y", sources: ["-1001"] })).not.toBe(base);
    expect(scopeFingerprint({ q: "x", sources: ["-1002"] })).not.toBe(base);
    expect(scopeFingerprint({ q: "x", sources: ["-1001"], to: "2026" })).not.toBe(
      base,
    );
  });
});

describe("the search cursors", () => {
  it("round-trips a global cursor", () => {
    const cursor = { rate: 42, peer: "-100111", id: 7, fingerprint: "abc" };
    expect(decodeSearchGlobalCursor(encodeSearchGlobalCursor(cursor))).toEqual(
      cursor,
    );
  });

  it("round-trips a per-source cursor", () => {
    const cursor = {
      sources: [
        { handle: "-100111", offsetId: 9 },
        { handle: "exampleuser", offsetId: 0 },
      ],
      fingerprint: "abc",
    };
    expect(decodeSearchSourcesCursor(encodeSearchSourcesCursor(cursor))).toEqual(
      cursor,
    );
  });

  it("round-trips thread and pinned cursors", () => {
    const cursor = { offsetId: 5, fingerprint: "abc" };
    expect(decodeThreadCursor(encodeThreadCursor(cursor))).toEqual(cursor);
    expect(decodePinnedCursor(encodePinnedCursor(cursor))).toEqual(cursor);
  });

  it("rejects a cursor from another tool", () => {
    const thread = encodeThreadCursor({ offsetId: 5, fingerprint: "abc" });
    expect(() => decodePinnedCursor(thread)).toThrow(GramScopeError);
    expect(() => decodeSearchGlobalCursor(thread)).toThrow(GramScopeError);
    expect(() => decodeSearchSourcesCursor(thread)).toThrow(GramScopeError);
  });
});

describe("assertSameScope", () => {
  it("passes an unchanged scope and rejects a changed one", () => {
    expect(() => assertSameScope("abc", "abc")).not.toThrow();
    try {
      assertSameScope("abc", "def");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GramScopeError);
      expect((err as GramScopeError).code).toBe("INVALID_CURSOR");
      expect((err as GramScopeError).message).toMatch(/scope/i);
    }
  });
});
```

Note: `describe`, `expect`, `it` and `GramScopeError` are already imported at
the top of `tests/pagination.test.ts`; add only the `@/pagination` names above
to the existing import from that module rather than writing a second import
statement.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/pagination.test.ts`
Expected: FAIL — `scopeFingerprint is not exported`.

- [ ] **Step 3: Write the implementation**

```ts
// append to src/pagination.ts; add `import { createHash } from "node:crypto";`
// at the top of the file.

export const SEARCH_GLOBAL_CURSOR_KIND = "search_global";
export const SEARCH_SOURCES_CURSOR_KIND = "search_sources";
export const THREAD_CURSOR_KIND = "thread";
export const PINNED_CURSOR_KIND = "pinned";

/** Sorted keys and dropped undefined, so an absent filter and an omitted one
 *  fingerprint alike and key order never matters. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, stable(entry)]),
    );
  }
  return value;
}

/**
 * Spec §8. A page-two cursor must not survive a changed query: without this the
 * second page silently answers a different question than the first.
 */
export function scopeFingerprint(parts: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(parts)))
    .digest("base64url")
    .slice(0, 16);
}

export function assertSameScope(found: string, expected: string): void {
  if (found === expected) return;
  throw new GramScopeError(
    "INVALID_CURSOR",
    "This cursor was issued for a different query, source selection or date range — the scope changed, so it no longer describes the same result set. Start a new search without a cursor.",
  );
}

export type SearchGlobalCursor = {
  /** The previous page's next_rate, Telegram's own resume key. */
  rate: number;
  /** Marked id of the last hit served; resolved to an InputPeer on resume. */
  peer: string;
  id: number;
  fingerprint: string;
};

const searchGlobalPayloadSchema = z.object({
  v: z.literal(CURSOR_VERSION),
  k: z.literal(SEARCH_GLOBAL_CURSOR_KIND),
  r: z.number().int(),
  p: z.string(),
  i: z.number().int(),
  f: z.string(),
});

export function encodeSearchGlobalCursor(cursor: SearchGlobalCursor): string {
  return encodePayload({
    v: CURSOR_VERSION,
    k: SEARCH_GLOBAL_CURSOR_KIND,
    r: cursor.rate,
    p: cursor.peer,
    i: cursor.id,
    f: cursor.fingerprint,
  });
}

export function decodeSearchGlobalCursor(raw: string): SearchGlobalCursor {
  const payload = decodePayload(
    raw,
    SEARCH_GLOBAL_CURSOR_KIND,
    searchGlobalPayloadSchema,
  );
  return {
    rate: payload.r,
    peer: payload.p,
    id: payload.i,
    fingerprint: payload.f,
  };
}

export type SearchSourcesCursor = {
  /** `handle`, not a marked id: see ResolvedSource.handle. */
  sources: Array<{ handle: string; offsetId: number }>;
  fingerprint: string;
};

const searchSourcesPayloadSchema = z.object({
  v: z.literal(CURSOR_VERSION),
  k: z.literal(SEARCH_SOURCES_CURSOR_KIND),
  s: z.array(z.object({ h: z.string(), o: z.number().int() })),
  f: z.string(),
});

export function encodeSearchSourcesCursor(cursor: SearchSourcesCursor): string {
  return encodePayload({
    v: CURSOR_VERSION,
    k: SEARCH_SOURCES_CURSOR_KIND,
    s: cursor.sources.map((source) => ({
      h: source.handle,
      o: source.offsetId,
    })),
    f: cursor.fingerprint,
  });
}

export function decodeSearchSourcesCursor(raw: string): SearchSourcesCursor {
  const payload = decodePayload(
    raw,
    SEARCH_SOURCES_CURSOR_KIND,
    searchSourcesPayloadSchema,
  );
  return {
    sources: payload.s.map((source) => ({
      handle: source.h,
      offsetId: source.o,
    })),
    fingerprint: payload.f,
  };
}

/** get_thread and get_pinned_messages page one stream by offset_id. Same
 *  shape, separate kinds: a thread cursor must not decode as a pinned one. */
export type OffsetCursor = { offsetId: number; fingerprint: string };

function offsetPayloadSchema<K extends string>(kind: K) {
  return z.object({
    v: z.literal(CURSOR_VERSION),
    k: z.literal(kind),
    o: z.number().int(),
    f: z.string(),
  });
}

function encodeOffsetCursor(kind: string, cursor: OffsetCursor): string {
  return encodePayload({
    v: CURSOR_VERSION,
    k: kind,
    o: cursor.offsetId,
    f: cursor.fingerprint,
  });
}

function decodeOffsetCursor<K extends string>(
  raw: string,
  kind: K,
): OffsetCursor {
  const payload = decodePayload(raw, kind, offsetPayloadSchema(kind));
  return { offsetId: payload.o, fingerprint: payload.f };
}

export function encodeThreadCursor(cursor: OffsetCursor): string {
  return encodeOffsetCursor(THREAD_CURSOR_KIND, cursor);
}

export function decodeThreadCursor(raw: string): OffsetCursor {
  return decodeOffsetCursor(raw, THREAD_CURSOR_KIND);
}

export function encodePinnedCursor(cursor: OffsetCursor): string {
  return encodeOffsetCursor(PINNED_CURSOR_KIND, cursor);
}

export function decodePinnedCursor(raw: string): OffsetCursor {
  return decodeOffsetCursor(raw, PINNED_CURSOR_KIND);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/pagination.test.ts`
Expected: PASS, including the pre-existing dialog and message cursor tests.

- [ ] **Step 5: Run the gates**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/pagination.ts tests/pagination.test.ts
git commit -m "feat: add search, thread and pinned cursor kinds with a scope fingerprint"
```

### Task 3: One reader for the three TL message-page shapes

`messages.searchGlobal`, `messages.search`, `messages.getReplies` and the pinned
search all return the same union — `messages.Messages` (bounded, no `count`),
`messages.MessagesSlice` (`count`, sometimes `nextRate`) and
`messages.ChannelMessages` (`count`, no `nextRate`). Three engines would
otherwise each re-derive where `count` lives.

**Files:**
- Create: `src/telegram/tl-messages.ts`
- Test: `tests/telegram-tl-messages.test.ts`

**Interfaces:**
- Consumes: `entityMarkedId` from `src/telegram/peer-id.ts`.
- Produces:
  - `type TlMessagesPage = { messages: Record<string, unknown>[]; titles: Map<string, string>; count?: number; nextRate?: number }`
  - `function readMessagesPage(raw: unknown): TlMessagesPage`

- [ ] **Step 1: Write the failing test**

```ts
// tests/telegram-tl-messages.test.ts
import { describe, expect, it } from "vitest";
import { readMessagesPage } from "@/telegram/tl-messages";

const chat = { className: "Channel", id: 111n, title: "Alpha" };

describe("readMessagesPage", () => {
  it("reads a slice with a total and a resume rate", () => {
    const page = readMessagesPage({
      className: "messages.MessagesSlice",
      count: 4820,
      nextRate: 1755000000,
      messages: [{ id: 7 }],
      chats: [chat],
      users: [],
    });
    expect(page.count).toBe(4820);
    expect(page.nextRate).toBe(1755000000);
    expect(page.messages).toEqual([{ id: 7 }]);
    expect(page.titles.get("-100111")).toBe("Alpha");
  });

  it("reads a bounded result, which carries no total", () => {
    const page = readMessagesPage({
      className: "messages.Messages",
      messages: [{ id: 7 }, { id: 6 }],
      chats: [],
      users: [],
    });
    expect(page.count).toBeUndefined();
    expect(page.nextRate).toBeUndefined();
    expect(page.messages).toHaveLength(2);
  });

  it("reads channel messages, which have a total but no rate", () => {
    const page = readMessagesPage({
      className: "messages.ChannelMessages",
      pts: 1,
      count: 217,
      messages: [{ id: 9 }],
      chats: [chat],
      users: [],
    });
    expect(page.count).toBe(217);
    expect(page.nextRate).toBeUndefined();
  });

  it("returns an empty page for anything else rather than throwing", () => {
    for (const raw of [undefined, null, {}, { className: "messages.MessagesNotModified" }]) {
      const page = readMessagesPage(raw);
      expect(page.messages).toEqual([]);
      expect(page.count).toBeUndefined();
    }
  });

  it("hands back a plain array, not a teleproto TotalList", () => {
    class TotalList extends Array {}
    const messages = TotalList.from([{ id: 1 }]) as unknown[];
    const page = readMessagesPage({ messages, chats: [], users: [] });
    expect(Object.getPrototypeOf(page.messages)).toBe(Array.prototype);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/telegram-tl-messages.test.ts`
Expected: FAIL — `Failed to resolve import "@/telegram/tl-messages"`.

- [ ] **Step 3: Write the implementation**

```ts
// src/telegram/tl-messages.ts
import { entityMarkedId } from "./peer-id";

/**
 * The flat view of every messages.* TL result this project reads:
 * messages.Messages (bounded, no count), messages.MessagesSlice (count, and a
 * nextRate on a global search) and messages.ChannelMessages (count, no rate).
 */
export type TlMessagesPage = {
  messages: Record<string, unknown>[];
  /** Marked id -> title, taken from the chats the response already carried, so
   *  naming a hit's source costs no extra round trip. */
  titles: Map<string, string>;
  /** Server-side total for the query. Absent on a bounded result. */
  count?: number;
  /** messages.searchGlobal's resume key. Absent everywhere else. */
  nextRate?: number;
};

function records(value: unknown): Record<string, unknown>[] {
  // Array.from: teleproto hands back an Array subclass carrying `total`, and
  // filter/map preserve it through Symbol.species.
  return Array.isArray(value)
    ? Array.from(value).filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null,
      )
    : [];
}

export function readMessagesPage(raw: unknown): TlMessagesPage {
  const page = (typeof raw === "object" && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >;

  const titles = new Map<string, string>();
  for (const chat of records(page.chats)) {
    const id = entityMarkedId(chat);
    if (id !== undefined && typeof chat.title === "string") {
      titles.set(id, chat.title);
    }
  }

  return {
    messages: records(page.messages),
    titles,
    ...(typeof page.count === "number" ? { count: page.count } : {}),
    ...(typeof page.nextRate === "number" ? { nextRate: page.nextRate } : {}),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/telegram-tl-messages.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/tl-messages.ts tests/telegram-tl-messages.test.ts
git commit -m "feat: read the three TL message-page shapes through one helper"
```

---

### Task 4: `get_thread` — a post and the comments under it

Spec §6.2. Two RPCs, because a post with zero comments and a channel with no
linked discussion group both fail `getReplies` with the same `MSG_ID_INVALID`
and are indistinguishable by error. The post's own `replies` block is the
discriminator, and the reading tools already return it, so a model can tell in
advance whether a thread is worth fetching.

**Files:**
- Modify: `src/errors/taxonomy.ts` (add `NO_DISCUSSION_THREAD`)
- Create: `src/telegram/thread.ts`
- Create: `src/mcp/tools/get-thread.ts`
- Modify: `src/mcp/server.ts`
- Test: `tests/telegram-thread.test.ts`
- Modify: `tests/mcp-handler.test.ts` (eight tools)

**Interfaces:**
- Consumes: `resolveSource` (Task 1); `decodeThreadCursor` / `encodeThreadCursor` / `scopeFingerprint` / `assertSameScope` (Task 2); `readMessagesPage` (Task 3); `mapMessage`, `MessageContext` from `src/schemas/message.ts`; `markedChannelId`, `readBigId` from `src/telegram/peer-id.ts`; `fitToSizeCap` from `src/schemas/size.ts`; `getApi`, `withTelegram` from `src/telegram/client.ts`; `fetchDialogIndex` from `src/telegram/dialog-index.ts`.
- Produces:
  - `type GetThreadInput = { source_id: string; post_id: number; limit: number; cursor?: string }`
  - `type GetThreadResult = { source_id: string; source_title: string; post: TelegramMessage; discussion_chat_id?: string; comment_count: number; comments: TelegramMessage[]; next_cursor?: string }`
  - `function getThread(input: GetThreadInput): Promise<GetThreadResult>`
  - `function registerGetThread(server: McpServer): void`

- [ ] **Step 1: Write the failing test**

```ts
// tests/telegram-thread.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { getThread } from "@/telegram/thread";
import {
  __resetClientForTests,
  __setClientFactoryForTests,
} from "@/telegram/client";
import { __resetPeerCacheForTests } from "@/telegram/peer-resolve";
import { decodeThreadCursor } from "@/pagination";
import { GramScopeError } from "@/errors/taxonomy";

const CHANNEL = "-1001111111111";
const GROUP = "-1002222222222";

function post(overrides: Record<string, unknown> = {}) {
  return {
    className: "Message",
    id: 500,
    date: 1_750_000_000,
    message: "the post",
    ...overrides,
  };
}

function comment(id: number) {
  return {
    className: "Message",
    id,
    date: 1_750_000_100 + id,
    message: `comment ${id}`,
  };
}

/** Stands in for the dialog index this tool fetches through fetchDialogIndex,
 *  which reaches Telegram through the same faked client. */
function dialogs() {
  return [
    {
      id: CHANNEL,
      title: "Alpha",
      entity: { className: "Channel", id: 1111111111n, title: "Alpha" },
      dialog: { readInboxMaxId: 0 },
      unreadCount: 0,
      date: 1,
      message: { id: 500 },
    },
  ];
}

type Invoked = { className: string; params: Record<string, unknown> };

function install(options: {
  post?: Record<string, unknown>;
  replies?: unknown;
}) {
  const invoked: Invoked[] = [];
  __setClientFactoryForTests(async () => ({
    connected: true,
    connect: async () => true,
    getDialogs: async () => dialogs(),
    getEntity: async () => ({ className: "Channel", id: 1111111111n }),
    getMessages: async () => (options.post ? [options.post] : []),
    invoke: async (request: unknown) => {
      const r = request as { className: string } & Record<string, unknown>;
      invoked.push({ className: r.className, params: { ...r } });
      if (r.className === "messages.GetReplies") return options.replies;
      return {};
    },
  }));
  return invoked;
}

afterEach(() => {
  __setClientFactoryForTests(undefined);
  __resetClientForTests();
  __resetPeerCacheForTests();
});

describe("getThread", () => {
  it("refuses a channel with no linked discussion group", async () => {
    install({ post: post() });
    await expect(
      getThread({ source_id: CHANNEL, post_id: 500, limit: 20 }),
    ).rejects.toMatchObject({ code: "NO_DISCUSSION_THREAD" });
  });

  it("returns an empty thread, not an error, when nobody commented", async () => {
    const invoked = install({
      post: post({ replies: { replies: 0, channelId: 2222222222n } }),
    });
    const result = await getThread({
      source_id: CHANNEL,
      post_id: 500,
      limit: 20,
    });
    expect(result.comment_count).toBe(0);
    expect(result.comments).toEqual([]);
    expect(result.discussion_chat_id).toBe(GROUP);
    expect(result.next_cursor).toBeUndefined();
    // The pre-check answered it: no getReplies was ever sent.
    expect(invoked.filter((c) => c.className === "messages.GetReplies")).toEqual(
      [],
    );
  });

  it("returns the post as the thread root with its comments", async () => {
    install({
      post: post({ replies: { replies: 215, channelId: 2222222222n } }),
      replies: {
        className: "messages.ChannelMessages",
        count: 217,
        messages: [comment(9), comment(8)],
        chats: [],
        users: [],
      },
    });
    const result = await getThread({
      source_id: CHANNEL,
      post_id: 500,
      limit: 2,
    });

    expect(result.source_id).toBe(CHANNEL);
    expect(result.source_title).toBe("Alpha");
    expect(result.post.id).toBe(500);
    // getReplies' live count, not the post's own slightly stale counter.
    expect(result.comment_count).toBe(217);
    expect(result.comments.map((c) => c.id)).toEqual([9, 8]);
    // Comments live in the discussion group, and the account is not a member,
    // so they carry that chat_id and no read state.
    expect(result.comments[0]!.chat_id).toBe(GROUP);
    expect(result.comments[0]!.is_read).toBeUndefined();
  });

  it("issues a cursor that resumes below the oldest comment served", async () => {
    install({
      post: post({ replies: { replies: 215, channelId: 2222222222n } }),
      replies: {
        className: "messages.ChannelMessages",
        count: 217,
        messages: [comment(9), comment(8)],
        chats: [],
        users: [],
      },
    });
    const first = await getThread({
      source_id: CHANNEL,
      post_id: 500,
      limit: 2,
    });
    expect(first.next_cursor).toBeTruthy();
    expect(decodeThreadCursor(first.next_cursor!).offsetId).toBe(8);
  });

  it("rejects a cursor issued for another post", async () => {
    install({
      post: post({ replies: { replies: 215, channelId: 2222222222n } }),
      replies: {
        className: "messages.ChannelMessages",
        count: 217,
        messages: [comment(9), comment(8)],
        chats: [],
        users: [],
      },
    });
    const first = await getThread({
      source_id: CHANNEL,
      post_id: 500,
      limit: 2,
    });
    await expect(
      getThread({
        source_id: CHANNEL,
        post_id: 501,
        limit: 2,
        cursor: first.next_cursor!,
      }),
    ).rejects.toBeInstanceOf(GramScopeError);
  });

  it("reports a missing post as MESSAGE_NOT_FOUND", async () => {
    install({});
    await expect(
      getThread({ source_id: CHANNEL, post_id: 500, limit: 20 }),
    ).rejects.toMatchObject({ code: "MESSAGE_NOT_FOUND" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/telegram-thread.test.ts`
Expected: FAIL — `Failed to resolve import "@/telegram/thread"`.

- [ ] **Step 3: Add the error code**

```ts
// src/errors/taxonomy.ts — inside ERROR_CODES, after "MESSAGE_NOT_FOUND"
  "NO_DISCUSSION_THREAD",
```

- [ ] **Step 4: Write the engine**

```ts
// src/telegram/thread.ts
import { getApi, withTelegram } from "./client";
import { fetchDialogIndex } from "./dialog-index";
import { resolveSource } from "./peer-resolve";
import { markedChannelId, readBigId } from "./peer-id";
import { readMessagesPage } from "./tl-messages";
import {
  assertSameScope,
  decodeThreadCursor,
  encodeThreadCursor,
  scopeFingerprint,
} from "../pagination";
import { fitToSizeCap } from "../schemas/size";
import { GramScopeError } from "../errors/taxonomy";
import {
  mapMessage,
  type MessageContext,
  type TelegramMessage,
} from "../schemas/message";

export type GetThreadInput = {
  source_id: string;
  post_id: number;
  limit: number;
  cursor?: string;
};

export type GetThreadResult = {
  source_id: string;
  source_title: string;
  post: TelegramMessage;
  discussion_chat_id?: string;
  comment_count: number;
  comments: TelegramMessage[];
  next_cursor?: string;
};

export async function getThread(
  input: GetThreadInput,
): Promise<GetThreadResult> {
  const index = await fetchDialogIndex();

  return withTelegram(async (client) => {
    const source = await resolveSource(client, index, input.source_id);
    const fingerprint = scopeFingerprint({
      source: source.source_id,
      post: input.post_id,
    });
    const cursor = input.cursor ? decodeThreadCursor(input.cursor) : undefined;
    if (cursor) assertSameScope(cursor.fingerprint, fingerprint);

    const found = await client.getMessages(source.handle, {
      ids: [input.post_id],
    });
    const raw = (found[0] ?? undefined) as Record<string, unknown> | undefined;
    if (
      !raw ||
      typeof raw.id !== "number" ||
      raw.className === "MessageEmpty"
    ) {
      throw new GramScopeError(
        "MESSAGE_NOT_FOUND",
        `No message ${input.post_id} in ${source.source_id}`,
      );
    }

    const entry = index.byId.get(source.source_id);
    const postContext: MessageContext = {
      chatId: source.source_id,
      ...(source.username !== undefined ? { username: source.username } : {}),
      ...(entry !== undefined
        ? { readInboxMaxId: entry.read_inbox_max_id }
        : {}),
    };

    // Spec §6.2: the post's own replies block is the only thing that tells a
    // channel with no linked group apart from a post nobody commented on.
    const replies = (raw.replies ?? undefined) as
      | Record<string, unknown>
      | undefined;
    if (!replies || typeof replies.replies !== "number") {
      throw new GramScopeError(
        "NO_DISCUSSION_THREAD",
        `${source.title} has no linked discussion group, so its posts carry no comment threads.`,
      );
    }

    const linkedBare = readBigId(replies.channelId);
    const base = {
      source_id: source.source_id,
      source_title: source.title,
      post: mapMessage(raw, postContext),
      // A linked discussion chat is always a megagroup, so a bare id marks as
      // a channel.
      ...(linkedBare !== undefined
        ? { discussion_chat_id: markedChannelId(linkedBare) }
        : {}),
    };

    if (replies.replies === 0) {
      return { ...base, comment_count: 0, comments: [] };
    }

    const Api = await getApi();
    // Every field is passed explicitly: teleproto does not fill TL defaults
    // for omitted non-flag parameters.
    const page = readMessagesPage(
      await client.invoke(
        new Api.messages.GetReplies({
          peer: source.handle as never,
          msgId: input.post_id,
          offsetId: cursor?.offsetId ?? 0,
          offsetDate: 0,
          addOffset: 0,
          limit: input.limit,
          maxId: 0,
          minId: 0,
          hash: 0 as never,
        }),
      ),
    );

    // Comments live in the discussion group, which the account is not a member
    // of: no read pointer, so no is_read, and no username, so no url.
    const commentContext: MessageContext = {
      chatId: base.discussion_chat_id ?? source.source_id,
    };
    const all = page.messages.map((message) =>
      mapMessage(message, commentContext),
    );

    const comment_count = page.count ?? replies.replies;
    const fit = fitToSizeCap(all, (kept) => ({
      ...base,
      comment_count,
      comments: kept,
    }));
    const comments = all.slice(0, fit);

    // getReplies is newest-first, so the oldest id served is the resume point.
    const exhausted = comments.length === all.length && all.length < input.limit;
    const oldest = comments[comments.length - 1];

    return {
      ...base,
      comment_count,
      comments,
      ...(exhausted || oldest === undefined
        ? {}
        : {
            next_cursor: encodeThreadCursor({
              offsetId: oldest.id,
              fingerprint,
            }),
          }),
    };
  });
}
```

- [ ] **Step 5: Run the engine test to verify it passes**

Run: `npx vitest run tests/telegram-thread.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Register the tool**

```ts
// src/mcp/tools/get-thread.ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { getThread } from "../../telegram/thread";
import { telegramMessageSchema } from "../../schemas/message";
import { runTool } from "../tool-result";

export function registerGetThread(server: McpServer): void {
  server.registerTool(
    "get_thread",
    {
      title: "Read the comments under a Telegram post",
      description:
        "Read the discussion thread under one channel post: the post itself plus the comments left on it, newest first. Works without joining the channel's linked discussion group. Before calling, check the post's replies field, which every message-returning tool already reports: it is the comment count, and a post that has no replies field belongs to a channel with no discussion group at all (NO_DISCUSSION_THREAD). A post with zero comments returns an empty comments list, not an error. comment_count is the discussion group's own live count and can run slightly ahead of the post's replies field. discussion_chat_id identifies the linked group but is NOT an address: get_messages cannot read it, because the account is not a member. Read-only.",
      inputSchema: z.object({
        source_id: z
          .string()
          .describe(
            "The CHANNEL the post is in — a marked id, a @username, or a t.me link. Not the discussion group.",
          ),
        post_id: z
          .number()
          .int()
          .describe("Message id of the post inside that channel."),
        limit: z.number().int().min(1).max(100).default(20),
        cursor: z
          .string()
          .describe(
            "Opaque continuation token from a previous response's next_cursor. Copy it back exactly as received, character for character; it is not human-readable and must not be shortened, re-typed or reconstructed. It is bound to this source_id and post_id.",
          )
          .optional(),
      }),
      outputSchema: z.object({
        source_id: z.string(),
        source_title: z.string(),
        post: telegramMessageSchema,
        discussion_chat_id: z.string().optional(),
        comment_count: z.number().int(),
        comments: z.array(telegramMessageSchema),
        next_cursor: z.string().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (input) => runTool("get_thread", () => getThread(input)),
  );
}
```

```ts
// src/mcp/server.ts — add the import next to the others and the call inside
// registerTools, after registerGetMessage(server);
import { registerGetThread } from "./tools/get-thread";
// ...
  registerGetThread(server);
```

- [ ] **Step 7: Extend the handler test to eight tools**

```ts
// tests/mcp-handler.test.ts — replace the name list in the first test
  it("advertises all eight tools", async () => {
    const tools = await listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "get_channel",
      "get_message",
      "get_messages",
      "get_thread",
      "get_unread_summary",
      "list_dialogs",
      "list_folders",
      "mark_read",
    ]);
  });
```

- [ ] **Step 8: Run the gates**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: all green; the handler test lists eight tools and still marks only
`mark_read` as mutating.

- [ ] **Step 9: Commit**

```bash
git add src/errors/taxonomy.ts src/telegram/thread.ts src/mcp/tools/get-thread.ts src/mcp/server.ts tests/telegram-thread.test.ts tests/mcp-handler.test.ts
git commit -m "feat: expose get_thread for comments under a channel post"
```

### Task 5: `search_messages` — validation, mode selection, and the global engine

Spec §6.1 and §7. The mode is derived from the arguments, never declared: no
source selection means one `messages.searchGlobal` call over every chat the
account participates in. This task builds the input contract, the fingerprint,
and that engine. Task 6 adds the fan-out; Task 7 exposes the tool.

**Files:**
- Modify: `src/telegram/message-slice.ts` (export `mediaFilter`)
- Create: `src/telegram/search.ts`
- Test: `tests/telegram-search.test.ts`

**Interfaces:**
- Consumes: `parseDateBound` from `src/telegram/messages.ts`; `readMessagesPage` (Task 3); the search cursors and `scopeFingerprint` / `assertSameScope` (Task 2); `inputPeerMarkedId` from `src/telegram/peer-id.ts`; `fitToSizeCap`; `fetchDialogIndex`.
- Produces:
  - `type SearchInput = { query: string; source_ids?: string[]; folder_ids?: string[]; exclude_source_ids?: string[]; from?: string; to?: string; media_type?: MediaType; limit: number; cursor?: string }`
  - `type SearchHit = TelegramMessage & { source_title: string }`
  - `type SearchSourceRollup = { source_id: string; title: string; hit_count: number; error?: { code: string; message: string } }`
  - `type SearchResult = { results: SearchHit[]; sources: SearchSourceRollup[]; total_matches?: number; next_cursor?: string }`
  - `function isFanout(input: SearchInput): boolean`
  - `type SearchBounds = { fromSeconds?: number; toSeconds?: number; fingerprint: string }`
  - `function prepareSearch(input: SearchInput): SearchBounds`
  - `function rollUp(hits: SearchHit[]): SearchSourceRollup[]`
  - `function searchMessages(input: SearchInput): Promise<SearchResult>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/telegram-search.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { isFanout, prepareSearch, searchMessages } from "@/telegram/search";
import {
  __resetClientForTests,
  __setClientFactoryForTests,
} from "@/telegram/client";
import { __resetPeerCacheForTests } from "@/telegram/peer-resolve";
import { decodeSearchGlobalCursor } from "@/pagination";
import { GramScopeError } from "@/errors/taxonomy";

const A = "-1001111111111";

function hit(id: number, date: number, channelId: bigint) {
  return {
    className: "Message",
    id,
    date,
    message: `hit ${id}`,
    peerId: { className: "PeerChannel", channelId },
  };
}

function dialogs() {
  return [
    {
      id: A,
      title: "Alpha",
      entity: { className: "Channel", id: 1111111111n, title: "Alpha" },
      dialog: { readInboxMaxId: 400 },
      unreadCount: 0,
      date: 1,
      message: { id: 500 },
    },
  ];
}

type Sent = { className: string; params: Record<string, unknown> };

function install(reply: unknown) {
  const sent: Sent[] = [];
  __setClientFactoryForTests(async () => ({
    connected: true,
    connect: async () => true,
    getDialogs: async () => dialogs(),
    getEntity: async (target: string) => ({
      className: "Channel",
      id: 1111111111n,
      target,
    }),
    getMessages: async () => [],
    invoke: async (request: unknown) => {
      const r = request as { className: string } & Record<string, unknown>;
      sent.push({ className: r.className, params: { ...r } });
      return reply;
    },
  }));
  return sent;
}

const slice = (messages: unknown[], extra: Record<string, unknown> = {}) => ({
  className: "messages.MessagesSlice",
  count: 4820,
  nextRate: 1_700_000_000,
  messages,
  chats: [{ className: "Channel", id: 1111111111n, title: "Alpha" }],
  users: [],
  ...extra,
});

afterEach(() => {
  __setClientFactoryForTests(undefined);
  __resetClientForTests();
  __resetPeerCacheForTests();
});

describe("mode selection", () => {
  it("is global with no source selection and fan-out with one", () => {
    expect(isFanout({ query: "x", limit: 10 })).toBe(false);
    expect(isFanout({ query: "x", limit: 10, source_ids: [A] })).toBe(true);
    expect(isFanout({ query: "x", limit: 10, folder_ids: ["2"] })).toBe(true);
    // An empty array is not a selection.
    expect(isFanout({ query: "x", limit: 10, source_ids: [] })).toBe(false);
  });
});

describe("prepareSearch", () => {
  it("rejects an empty query", () => {
    expect(() => prepareSearch({ query: "   ", limit: 10 })).toThrow(
      GramScopeError,
    );
  });

  it("rejects exclude_source_ids without a source selection", () => {
    try {
      prepareSearch({ query: "x", limit: 10, exclude_source_ids: [A] });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as GramScopeError).code).toBe("INVALID_INPUT");
      // The message must say WHY, per spec §6.1: Telegram offers no exclusion
      // in global mode and filtering a returned page would break limit.
      expect((err as GramScopeError).message).toMatch(/source_ids|folder_ids/);
    }
  });

  it("rejects a reversed date range", () => {
    try {
      prepareSearch({
        query: "x",
        limit: 10,
        from: "2026-01-02T00:00:00Z",
        to: "2026-01-01T00:00:00Z",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as GramScopeError).code).toBe("INVALID_DATE_RANGE");
    }
  });

  it("fingerprints the query and every filter", () => {
    const base = prepareSearch({ query: "x", limit: 10 }).fingerprint;
    expect(prepareSearch({ query: "x", limit: 50 }).fingerprint).toBe(base);
    expect(prepareSearch({ query: "y", limit: 10 }).fingerprint).not.toBe(base);
    expect(
      prepareSearch({ query: "x", limit: 10, from: "2026-01-01T00:00:00Z" })
        .fingerprint,
    ).not.toBe(base);
    expect(
      prepareSearch({ query: "x", limit: 10, media_type: "photo" }).fingerprint,
    ).not.toBe(base);
  });
});

describe("global search", () => {
  it("sends one searchGlobal and flattens its hits", async () => {
    const sent = install(
      slice([hit(9, 1_750_000_200, 1111111111n), hit(8, 1_750_000_100, 1111111111n)]),
    );
    const page = await searchMessages({ query: "ai", limit: 10 });

    expect(sent.map((s) => s.className)).toEqual(["messages.SearchGlobal"]);
    expect(sent[0]!.params.q).toBe("ai");
    expect(page.results.map((r) => r.id)).toEqual([9, 8]);
    expect(page.results[0]!.chat_id).toBe(A);
    expect(page.results[0]!.source_title).toBe("Alpha");
    // The dialog index supplies the read pointer for the account's own chats.
    expect(page.results[0]!.is_read).toBe(false);
    expect(page.total_matches).toBe(4820);
    expect(page.sources).toEqual([
      { source_id: A, title: "Alpha", hit_count: 2 },
    ]);
  });

  it("passes the date window to Telegram rather than filtering here", async () => {
    const sent = install(slice([]));
    await searchMessages({
      query: "ai",
      limit: 10,
      from: "2024-01-01T00:00:00Z",
      to: "2026-01-01T00:00:00Z",
    });
    expect(sent[0]!.params.minDate).toBe(1_704_067_200);
    expect(sent[0]!.params.maxDate).toBe(1_767_225_600);
  });

  it("issues a cursor carrying the server's rate and resumes with it", async () => {
    install(
      slice([hit(9, 1_750_000_200, 1111111111n), hit(8, 1_750_000_100, 1111111111n)]),
    );
    const first = await searchMessages({ query: "ai", limit: 2 });
    const cursor = decodeSearchGlobalCursor(first.next_cursor!);
    expect(cursor).toMatchObject({ rate: 1_700_000_000, peer: A, id: 8 });

    const sent = install(slice([]));
    await searchMessages({ query: "ai", limit: 2, cursor: first.next_cursor! });
    expect(sent[0]!.params.offsetRate).toBe(1_700_000_000);
    expect(sent[0]!.params.offsetId).toBe(8);
  });

  it("stops paging when the page came back short", async () => {
    install(slice([hit(9, 1_750_000_200, 1111111111n)]));
    const page = await searchMessages({ query: "ai", limit: 10 });
    expect(page.next_cursor).toBeUndefined();
  });

  it("rejects a cursor whose query no longer matches", async () => {
    install(
      slice([hit(9, 1_750_000_200, 1111111111n), hit(8, 1_750_000_100, 1111111111n)]),
    );
    const first = await searchMessages({ query: "ai", limit: 2 });
    await expect(
      searchMessages({ query: "robots", limit: 2, cursor: first.next_cursor! }),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });

  it("keeps an oversized page under the response cap and resumes below it", async () => {
    const big = (id: number, date: number) => ({
      ...hit(id, date, 1111111111n),
      message: "x".repeat(20_000),
    });
    install(
      slice(
        Array.from({ length: 40 }, (_, n) => big(100 - n, 1_750_000_000 - n)),
      ),
    );
    const page = await searchMessages({ query: "ai", limit: 40 });
    expect(
      Buffer.byteLength(JSON.stringify(page), "utf8"),
    ).toBeLessThanOrEqual(256 * 1024);
    expect(page.results.length).toBeLessThan(40);
    const last = page.results[page.results.length - 1]!;
    expect(decodeSearchGlobalCursor(page.next_cursor!).id).toBe(last.id);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/telegram-search.test.ts`
Expected: FAIL — `Failed to resolve import "@/telegram/search"`.

- [ ] **Step 3: Export the media filter**

```ts
// src/telegram/message-slice.ts — change the declaration only
export async function mediaFilter(type: MediaType | undefined): Promise<unknown> {
```

- [ ] **Step 4: Write the engine**

```ts
// src/telegram/search.ts
import { getApi, withTelegram, type TelegramLike } from "./client";
import { fetchDialogIndex, type DialogIndex } from "./dialog-index";
import { mediaFilter, type MediaType } from "./message-slice";
import { parseDateBound } from "./messages";
import { inputPeerMarkedId } from "./peer-id";
import { readMessagesPage } from "./tl-messages";
import {
  assertSameScope,
  decodeSearchGlobalCursor,
  encodeSearchGlobalCursor,
  scopeFingerprint,
} from "../pagination";
import { fitToSizeCap } from "../schemas/size";
import { GramScopeError } from "../errors/taxonomy";
import {
  mapMessage,
  type MessageContext,
  type TelegramMessage,
} from "../schemas/message";

export type SearchInput = {
  query: string;
  source_ids?: string[];
  folder_ids?: string[];
  exclude_source_ids?: string[];
  from?: string;
  to?: string;
  media_type?: MediaType;
  limit: number;
  cursor?: string;
};

export type SearchHit = TelegramMessage & { source_title: string };

export type SearchSourceRollup = {
  source_id: string;
  title: string;
  hit_count: number;
  error?: { code: string; message: string };
};

export type SearchResult = {
  results: SearchHit[];
  sources: SearchSourceRollup[];
  total_matches?: number;
  next_cursor?: string;
};

/**
 * Spec §6.1: the engine is derived from the arguments, so the model cannot
 * choose a wrong one. An empty array is not a selection.
 */
export function isFanout(input: SearchInput): boolean {
  return (
    (input.source_ids?.length ?? 0) > 0 || (input.folder_ids?.length ?? 0) > 0
  );
}

export type SearchBounds = {
  fromSeconds?: number;
  toSeconds?: number;
  fingerprint: string;
};

export function prepareSearch(input: SearchInput): SearchBounds {
  if (input.query.trim().length === 0) {
    throw new GramScopeError("INVALID_INPUT", "query must not be empty");
  }
  if ((input.exclude_source_ids?.length ?? 0) > 0 && !isFanout(input)) {
    throw new GramScopeError(
      "INVALID_INPUT",
      "exclude_source_ids only applies when searching named sources. Telegram offers no exclusion for an account-wide search, and dropping excluded hits from a returned page would shrink it below limit. Pass source_ids or folder_ids, or drop the exclusion.",
    );
  }

  const fromSeconds = parseDateBound(input.from, "from");
  const toSeconds = parseDateBound(input.to, "to");
  if (
    fromSeconds !== undefined &&
    toSeconds !== undefined &&
    fromSeconds > toSeconds
  ) {
    throw new GramScopeError("INVALID_DATE_RANGE", "from is after to");
  }

  return {
    ...(fromSeconds !== undefined ? { fromSeconds } : {}),
    ...(toSeconds !== undefined ? { toSeconds } : {}),
    // Everything that defines the result set, and nothing that only defines
    // the page: limit may change between pages, the query may not. Dates go in
    // as parsed seconds so two spellings of one instant agree.
    fingerprint: scopeFingerprint({
      q: input.query.trim(),
      sources: input.source_ids,
      folders: input.folder_ids,
      exclude: input.exclude_source_ids,
      from: fromSeconds,
      to: toSeconds,
      media: input.media_type,
    }),
  };
}

export function rollUp(hits: SearchHit[]): SearchSourceRollup[] {
  const byId = new Map<string, SearchSourceRollup>();
  for (const hit of hits) {
    const found = byId.get(hit.chat_id);
    if (found) found.hit_count++;
    else {
      byId.set(hit.chat_id, {
        source_id: hit.chat_id,
        title: hit.source_title,
        hit_count: 1,
      });
    }
  }
  return [...byId.values()];
}

function unixSeconds(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

async function searchFilter(mediaType: MediaType | undefined): Promise<unknown> {
  const Api = await getApi();
  return (await mediaFilter(mediaType)) ?? new Api.InputMessagesFilterEmpty();
}

async function globalPage(
  client: TelegramLike,
  index: DialogIndex,
  input: SearchInput,
  bounds: SearchBounds,
): Promise<SearchResult> {
  const Api = await getApi();
  const cursor = input.cursor
    ? decodeSearchGlobalCursor(input.cursor)
    : undefined;
  if (cursor) assertSameScope(cursor.fingerprint, bounds.fingerprint);

  const page = readMessagesPage(
    await client.invoke(
      new Api.messages.SearchGlobal({
        q: input.query.trim(),
        filter: (await searchFilter(input.media_type)) as never,
        minDate: bounds.fromSeconds ?? 0,
        maxDate: bounds.toSeconds ?? 0,
        offsetRate: cursor?.rate ?? 0,
        // A marked id resolves for every peer searchGlobal can return, because
        // it only searches chats the account participates in.
        offsetPeer: (cursor
          ? await client.getEntity(cursor.peer)
          : new Api.InputPeerEmpty()) as never,
        offsetId: cursor?.id ?? 0,
        limit: input.limit,
      }),
    ),
  );

  const all: SearchHit[] = page.messages.map((raw) => {
    const chatId = inputPeerMarkedId(raw.peerId) ?? "";
    const entry = index.byId.get(chatId);
    const context: MessageContext = {
      chatId,
      ...(entry?.username !== undefined ? { username: entry.username } : {}),
      ...(entry !== undefined
        ? { readInboxMaxId: entry.read_inbox_max_id }
        : {}),
    };
    return {
      ...mapMessage(raw, context),
      source_title: entry?.title ?? page.titles.get(chatId) ?? chatId,
    };
  });

  const fit = fitToSizeCap(all, (kept) => ({
    results: kept,
    sources: rollUp(kept),
    ...(page.count !== undefined ? { total_matches: page.count } : {}),
  }));
  const results = all.slice(0, fit);
  const last = results[results.length - 1];

  // A short page means Telegram had nothing more for this query.
  const complete = results.length === all.length;
  const exhausted = complete && all.length < input.limit;

  let next_cursor: string | undefined;
  if (last !== undefined && !exhausted) {
    next_cursor = encodeSearchGlobalCursor({
      // A complete page resumes on the server's own next_rate, which the live
      // probe walked for twelve pages with zero duplicates. A page the size
      // cap cut short cannot: next_rate points past the hits we did not serve.
      // The rate tracks the message date, so resuming at the last SERVED hit's
      // date may re-serve a hit that shares that second, but never skips one.
      rate: complete ? (page.nextRate ?? unixSeconds(last.date)) : unixSeconds(last.date),
      peer: last.chat_id,
      id: last.id,
      fingerprint: bounds.fingerprint,
    });
  }

  return {
    results,
    sources: rollUp(results),
    ...(page.count !== undefined ? { total_matches: page.count } : {}),
    ...(next_cursor !== undefined ? { next_cursor } : {}),
  };
}

export async function searchMessages(
  input: SearchInput,
): Promise<SearchResult> {
  const bounds = prepareSearch(input);
  const index = await fetchDialogIndex();
  return withTelegram(async (client) =>
    globalPage(client, index, input, bounds),
  );
}
```

`searchMessages` gains its fan-out branch in Task 6; until then it serves the
global engine only, which is what this task's tests cover.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/telegram-search.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 6: Run the gates**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/telegram/search.ts src/telegram/message-slice.ts tests/telegram-search.test.ts
git commit -m "feat: search the whole account with one messages.searchGlobal call"
```

### Task 6: `search_messages` — the fan-out engine

Spec §6.1 and §7. Naming any source or folder switches the engine to one
`messages.search` per source at concurrency 8, merged by date. Each source's
stream is independently ordered, so the resume point is simply the last hit
served from that source — there is no trimmed-block bookkeeping of the kind
`get_messages` needs, where the group order is fixed.

**Files:**
- Modify: `src/telegram/search.ts`
- Modify: `tests/telegram-search.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `resolveSource` and `parseTelegramName` (Task 1); `folderMembers` from `src/telegram/dialog-index.ts`; `MAX_SOURCES_PER_CALL` from `src/telegram/messages.ts`; `FANOUT_CONCURRENCY`, `mapWithConcurrency` from `src/concurrency.ts`; `mapTelegramError` from `src/errors/from-telegram.ts`; `decodeSearchSourcesCursor` / `encodeSearchSourcesCursor` (Task 2).
- Produces: no new exported names; `searchMessages` gains its second branch.

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/telegram-search.test.ts
import { decodeSearchSourcesCursor } from "@/pagination";

const B = "-1002222222222";

function twoDialogs() {
  return [
    {
      id: A,
      title: "Alpha",
      entity: { className: "Channel", id: 1111111111n, title: "Alpha" },
      dialog: { readInboxMaxId: 400 },
      unreadCount: 0,
      date: 1,
      message: { id: 500 },
    },
    {
      id: B,
      title: "Beta",
      entity: { className: "Channel", id: 2222222222n, title: "Beta" },
      dialog: { readInboxMaxId: 0 },
      unreadCount: 0,
      date: 1,
      message: { id: 500 },
    },
  ];
}

/** Replies per peer, so a fan-out can be asserted source by source. */
function installFanout(
  replies: Record<string, unknown | (() => never)>,
  folders: unknown[] = [],
) {
  const sent: Sent[] = [];
  __setClientFactoryForTests(async () => ({
    connected: true,
    connect: async () => true,
    getDialogs: async () => twoDialogs(),
    getEntity: async (target: string) => ({
      className: "Channel",
      id: target === B ? 2222222222n : 1111111111n,
    }),
    getMessages: async () => [],
    invoke: async (request: unknown) => {
      const r = request as { className: string } & Record<string, unknown>;
      sent.push({ className: r.className, params: { ...r } });
      if (r.className === "messages.GetDialogFilters") return folders;
      const peer = String(r.peer);
      const reply = replies[peer];
      if (typeof reply === "function") return (reply as () => never)();
      return reply ?? slice([]);
    },
  }));
  return sent;
}

describe("fan-out search", () => {
  it("searches each named source and merges the hits by date", async () => {
    const sent = installFanout({
      [A]: slice([hit(9, 1_750_000_300, 1111111111n)]),
      [B]: slice([hit(4, 1_750_000_400, 2222222222n)]),
    });
    const page = await searchMessages({
      query: "ai",
      source_ids: [A, B],
      limit: 10,
    });

    const searches = sent.filter((s) => s.className === "messages.Search");
    expect(searches).toHaveLength(2);
    expect(searches[0]!.params.q).toBe("ai");
    // Newest first across sources, not grouped by source.
    expect(page.results.map((r) => r.id)).toEqual([4, 9]);
    expect(page.results.map((r) => r.source_title)).toEqual(["Beta", "Alpha"]);
    // total_matches sums the per-source counts in this mode.
    expect(page.total_matches).toBe(9640);
  });

  it("lists a searched source that matched nothing", async () => {
    installFanout({
      [A]: slice([hit(9, 1_750_000_300, 1111111111n)]),
      [B]: slice([]),
    });
    const page = await searchMessages({
      query: "ai",
      source_ids: [A, B],
      limit: 10,
    });
    expect(page.sources).toEqual([
      { source_id: A, title: "Alpha", hit_count: 1 },
      { source_id: B, title: "Beta", hit_count: 0 },
    ]);
  });

  it("isolates one failing source instead of failing the page", async () => {
    installFanout({
      [A]: slice([hit(9, 1_750_000_300, 1111111111n)]),
      [B]: () => {
        throw Object.assign(new Error("boom"), {
          errorMessage: "CHANNEL_PRIVATE",
        });
      },
    });
    const page = await searchMessages({
      query: "ai",
      source_ids: [A, B],
      limit: 10,
    });
    expect(page.results.map((r) => r.id)).toEqual([9]);
    expect(page.sources[1]).toEqual({
      source_id: B,
      title: "Beta",
      hit_count: 0,
      error: {
        code: "PRIVATE_CHANNEL_NOT_ACCESSIBLE",
        message: "Telegram error: CHANNEL_PRIVATE",
      },
    });
  });

  it("cursors only the sources that still have more, and never a failed one", async () => {
    installFanout({
      // Alpha filled its page, so it may have more.
      [A]: slice([
        hit(9, 1_750_000_300, 1111111111n),
        hit(8, 1_750_000_200, 1111111111n),
      ]),
      // Beta came back short: exhausted.
      [B]: slice([hit(4, 1_750_000_100, 2222222222n)]),
    });
    const page = await searchMessages({
      query: "ai",
      source_ids: [A, B],
      limit: 2,
    });
    const cursor = decodeSearchSourcesCursor(page.next_cursor!);
    expect(cursor.sources).toEqual([{ handle: A, offsetId: 8 }]);
  });

  it("drops an excluded source before spending a request on it", async () => {
    const sent = installFanout({
      [A]: slice([hit(9, 1_750_000_300, 1111111111n)]),
      [B]: slice([hit(4, 1_750_000_400, 2222222222n)]),
    });
    const page = await searchMessages({
      query: "ai",
      source_ids: [A, B],
      exclude_source_ids: [B],
      limit: 10,
    });
    expect(sent.filter((s) => s.className === "messages.Search")).toHaveLength(
      1,
    );
    expect(page.sources.map((s) => s.source_id)).toEqual([A]);
  });

  it("refuses a selection wider than the fan-out ceiling", async () => {
    installFanout({});
    await expect(
      searchMessages({
        query: "ai",
        source_ids: Array.from({ length: 26 }, (_, n) => `-100${n}`),
        limit: 10,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("refuses a folder selection that resolves to no sources", async () => {
    installFanout({}, [
      {
        className: "DialogFilter",
        id: 9,
        title: "Empty",
        includePeers: [],
        excludePeers: [],
        pinnedPeers: [],
      },
    ]);
    await expect(
      searchMessages({ query: "ai", folder_ids: ["9"], limit: 10 }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
```

`{ source_ids: [], folder_ids: [] }` is deliberately NOT an error: `isFanout`
reads empty arrays as no selection at all, which is a valid account-wide
search. The case that needs the guard is a folder that exists and holds
nothing, which is what the last test covers.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/telegram-search.test.ts`
Expected: FAIL — the fan-out `describe` fails; the global tests from Task 5 still pass.

- [ ] **Step 3: Write the fan-out engine**

```ts
// src/telegram/search.ts — add to the imports
import { FANOUT_CONCURRENCY, mapWithConcurrency } from "../concurrency";
import { folderMembers } from "./dialog-index";
import { MAX_SOURCES_PER_CALL } from "./messages";
import { parseTelegramName, resolveSource, type ResolvedSource } from "./peer-resolve";
import { mapTelegramError } from "../errors/from-telegram";
import {
  decodeSearchSourcesCursor,
  encodeSearchSourcesCursor,
} from "../pagination";
```

```ts
// src/telegram/search.ts — append

/** One key per way of naming the same peer, so an exclusion written as
 *  @name removes a folder member listed by id once that member resolves. */
function nameKeys(source: {
  source_id?: string;
  username?: string;
  handle?: string;
}): string[] {
  const keys: string[] = [];
  if (source.source_id) keys.push(`i:${source.source_id}`);
  if (source.username) keys.push(`u:${source.username.toLowerCase()}`);
  if (source.handle) {
    const link = parseTelegramName(source.handle);
    keys.push(
      link.kind === "username"
        ? `u:${link.username.toLowerCase()}`
        : `i:${link.markedId}`,
    );
  }
  return keys;
}

function nameKey(raw: string): string {
  const link = parseTelegramName(raw);
  return link.kind === "username"
    ? `u:${link.username.toLowerCase()}`
    : `i:${link.markedId}`;
}

function targetNames(input: SearchInput, index: DialogIndex): string[] {
  const excluded = new Set((input.exclude_source_ids ?? []).map(nameKey));
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const name of [
    ...(input.source_ids ?? []),
    ...folderMembers(index.folders, input.folder_ids ?? []),
  ]) {
    const key = nameKey(name);
    if (excluded.has(key) || seen.has(key)) continue;
    seen.add(key);
    ordered.push(name);
  }

  if (ordered.length === 0) {
    throw new GramScopeError(
      "INVALID_INPUT",
      "This selection resolves to no sources. Name at least one source, or pick a folder that has members.",
    );
  }
  if (ordered.length > MAX_SOURCES_PER_CALL) {
    throw new GramScopeError(
      "INVALID_INPUT",
      `This selection resolves to ${ordered.length} sources; the limit is ${MAX_SOURCES_PER_CALL}. Split the call.`,
    );
  }
  return ordered;
}

type Outcome = {
  source_id: string;
  title: string;
  handle: string;
  /** Where this page started reading; the resume point if it served nothing. */
  startOffsetId: number;
  hits: SearchHit[];
  fetched: number;
  count?: number;
  error?: { code: string; message: string };
};

async function sourcesPage(
  client: TelegramLike,
  index: DialogIndex,
  input: SearchInput,
  bounds: SearchBounds,
): Promise<SearchResult> {
  const Api = await getApi();
  const cursor = input.cursor
    ? decodeSearchSourcesCursor(input.cursor)
    : undefined;
  if (cursor) assertSameScope(cursor.fingerprint, bounds.fingerprint);

  // A cursor carries its own source set, so a continuation never re-derives
  // one from folder membership that may have changed between pages.
  const targets = cursor
    ? cursor.sources
    : targetNames(input, index).map((handle) => ({ handle, offsetId: 0 }));

  // Resolution first, in its own pass: it is free for peers the account holds,
  // and doing it before the searches means an excluded source never costs a
  // request.
  type Target = { target: (typeof targets)[number]; resolved?: ResolvedSource; error?: Outcome };
  const prepared: Target[] = await mapWithConcurrency(
    targets,
    FANOUT_CONCURRENCY,
    async (target) => {
      try {
        return { target, resolved: await resolveSource(client, index, target.handle) };
      } catch (err) {
        const mapped = mapTelegramError(err);
        return {
          target,
          error: {
            source_id: target.handle,
            title: target.handle,
            handle: target.handle,
            startOffsetId: target.offsetId,
            hits: [],
            fetched: 0,
            error: { code: mapped.code, message: mapped.message },
          },
        };
      }
    },
  );

  const excluded = new Set((input.exclude_source_ids ?? []).map(nameKey));
  const kept = cursor
    ? prepared
    : prepared.filter(
        (item) =>
          item.resolved === undefined ||
          !nameKeys(item.resolved).some((key) => excluded.has(key)),
      );

  const filter = await searchFilter(input.media_type);
  const outcomes: Outcome[] = await mapWithConcurrency(
    kept,
    FANOUT_CONCURRENCY,
    async (item): Promise<Outcome> => {
      if (item.error) return item.error;
      const source = item.resolved!;
      const base = {
        source_id: source.source_id,
        title: source.title,
        handle: source.handle,
        startOffsetId: item.target.offsetId,
      };
      try {
        // Every field explicit: teleproto does not fill TL defaults for
        // omitted non-flag parameters.
        const page = readMessagesPage(
          await client.invoke(
            new Api.messages.Search({
              peer: source.handle as never,
              q: input.query.trim(),
              filter: filter as never,
              minDate: bounds.fromSeconds ?? 0,
              maxDate: bounds.toSeconds ?? 0,
              offsetId: item.target.offsetId,
              addOffset: 0,
              limit: input.limit,
              maxId: 0,
              minId: 0,
              hash: 0 as never,
            }),
          ),
        );

        const entry = index.byId.get(source.source_id);
        const context: MessageContext = {
          chatId: source.source_id,
          ...(source.username !== undefined
            ? { username: source.username }
            : {}),
          ...(entry !== undefined
            ? { readInboxMaxId: entry.read_inbox_max_id }
            : {}),
        };

        return {
          ...base,
          hits: page.messages.map((raw) => ({
            ...mapMessage(raw, context),
            source_title: source.title,
          })),
          fetched: page.messages.length,
          ...(page.count !== undefined ? { count: page.count } : {}),
        };
      } catch (err) {
        // House rule: one dead source must not cost the page.
        const mapped = mapTelegramError(err);
        return {
          ...base,
          hits: [],
          fetched: 0,
          error: { code: mapped.code, message: mapped.message },
        };
      }
    },
  );

  type Unit = { outcomeIndex: number; hit: SearchHit };
  const merged: Unit[] = outcomes
    .flatMap((outcome, outcomeIndex) =>
      outcome.hits.map((hit) => ({ outcomeIndex, hit })),
    )
    .sort(
      (a, b) =>
        Date.parse(b.hit.date) - Date.parse(a.hit.date) || b.hit.id - a.hit.id,
    );

  const totals = outcomes
    .map((outcome) => outcome.count)
    .filter((count): count is number => count !== undefined);
  const total_matches =
    totals.length > 0 ? totals.reduce((sum, count) => sum + count, 0) : undefined;

  const compose = (units: Unit[]): SearchResult => {
    const servedCount = new Array<number>(outcomes.length).fill(0);
    for (const unit of units) servedCount[unit.outcomeIndex]!++;
    return {
      results: units.map((unit) => unit.hit),
      sources: outcomes.map((outcome, i) => ({
        source_id: outcome.source_id,
        title: outcome.title,
        hit_count: servedCount[i]!,
        ...(outcome.error ? { error: outcome.error } : {}),
      })),
      ...(total_matches !== undefined ? { total_matches } : {}),
    };
  };

  const limited = merged.slice(0, input.limit);
  const served = limited.slice(0, fitToSizeCap(limited, compose));
  const page = compose(served);

  // Per source: the oldest hit actually served is the resume point, its start
  // offset if it served none, and nothing at all if it is exhausted or failed.
  const unexhausted: Array<{ handle: string; offsetId: number }> = [];
  for (let i = 0; i < outcomes.length; i++) {
    const outcome = outcomes[i]!;
    if (outcome.error) continue;
    const servedHits = served
      .filter((unit) => unit.outcomeIndex === i)
      .map((unit) => unit.hit);
    const exhausted =
      servedHits.length === outcome.hits.length && outcome.fetched < input.limit;
    if (exhausted) continue;
    unexhausted.push({
      handle: outcome.handle,
      offsetId:
        servedHits.length > 0
          ? Math.min(...servedHits.map((hit) => hit.id))
          : outcome.startOffsetId,
    });
  }

  return {
    ...page,
    ...(unexhausted.length > 0
      ? {
          next_cursor: encodeSearchSourcesCursor({
            sources: unexhausted,
            fingerprint: bounds.fingerprint,
          }),
        }
      : {}),
  };
}
```

A continuation resends every filter unchanged, so the mode derived from the
arguments always matches the one that issued the cursor; a cursor of the other
kind fails on its discriminator, which is what that field is for. The cursor
therefore needs no branch of its own here.

```ts
// src/telegram/search.ts — replace searchMessages
export async function searchMessages(
  input: SearchInput,
): Promise<SearchResult> {
  const bounds = prepareSearch(input);
  const index = await fetchDialogIndex();
  return withTelegram(async (client) =>
    isFanout(input)
      ? sourcesPage(client, index, input, bounds)
      : globalPage(client, index, input, bounds),
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/telegram-search.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Run the gates**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/telegram/search.ts tests/telegram-search.test.ts
git commit -m "feat: search named sources and folders with a merged fan-out"
```

### Task 7: Expose `search_messages`

Spec §6.1 and §9. The response is flat and date-ordered with a per-source
roll-up, not grouped: a global search page is a slice of a ranked stream across
all chats, so its groups would be an artifact of the page and the same source
would reappear as a fresh group on every subsequent page.

**Files:**
- Create: `src/mcp/tools/search-messages.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/mcp/tool-result.ts`
- Modify: `tests/logging.test.ts` (append one test)
- Modify: `tests/mcp-handler.test.ts` (nine tools)

**Interfaces:**
- Consumes: `searchMessages`, `SearchResult` (Tasks 5-6); `telegramMessageSchema`; `MEDIA_TYPES`; `MAX_SOURCES_PER_CALL`; `runTool`.
- Produces: `function registerSearchMessages(server: McpServer): void`

- [ ] **Step 1: Write the failing log test**

```ts
// append to tests/logging.test.ts, inside the "runTool logging" describe
  it("counts a flat search page by its hits, not by its sources", async () => {
    const lines: string[] = [];
    await runTool(
      "search_messages",
      async () => ({
        results: [
          { id: 1, chat_id: "-100111", date: "x", source_title: "Alpha" },
          { id: 2, chat_id: "-100222", date: "x", source_title: "Beta" },
          { id: 3, chat_id: "-100222", date: "x", source_title: "Beta" },
        ],
        sources: [
          { source_id: "-100111", title: "Alpha", hit_count: 1 },
          { source_id: "-100222", title: "Beta", hit_count: 2 },
        ],
      }),
      (line) => lines.push(line),
    );
    expect(lines[0]).toContain("count=3");
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/logging.test.ts`
Expected: FAIL — `count=2`, because `countOf` finds `sources` before `results`.

- [ ] **Step 3: Teach `countOf` the flat shape**

```ts
// src/mcp/tool-result.ts — inside countOf, reorder the keys and say why
  // `results` first: a flat search page carries BOTH a results list and a
  // sources roll-up, and what the call returned is the hits, not the number
  // of sources they came from.
  for (const key of ["results", "sources", "folders", "groups"]) {
```

- [ ] **Step 4: Verify the log test passes**

Run: `npx vitest run tests/logging.test.ts`
Expected: PASS, including the pre-existing `get_messages` count test.

- [ ] **Step 5: Register the tool**

```ts
// src/mcp/tools/search-messages.ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { searchMessages } from "../../telegram/search";
import { MAX_SOURCES_PER_CALL } from "../../telegram/messages";
import { MEDIA_TYPES } from "../../telegram/message-slice";
import { telegramMessageSchema } from "../../schemas/message";
import { runTool } from "../tool-result";

export function registerSearchMessages(server: McpServer): void {
  server.registerTool(
    "search_messages",
    {
      title: "Search Telegram messages",
      description:
        "Full-text search over Telegram messages. With no source_ids and no folder_ids it searches EVERY chat the account participates in, in one call. Naming source_ids or folder_ids instead searches those sources only, up to " +
        `${MAX_SOURCES_PER_CALL} of them. There is no third mode and no engine to choose: it follows from the arguments. It cannot search public channels the account has not joined — that requires Telegram Premium and costs Stars — but it CAN search inside one such channel when you name it by @username or t.me link in source_ids. Results are a flat list ordered newest first, NOT grouped by source: every hit carries chat_id and source_title, and the sources roll-up says how many hits on THIS page came from each source. total_matches is Telegram's own estimate for the whole query and drifts; use it to decide whether to narrow, not to compute with. from/to and media_type are applied by Telegram, so a filtered page is never short for that reason. exclude_source_ids works only together with source_ids or folder_ids. To continue, resend every filter unchanged with next_cursor; changing the query or a filter invalidates it. Read-only.`,
      inputSchema: z.object({
        query: z.string().min(1).describe("The text to search for."),
        source_ids: z
          .array(z.string())
          .optional()
          .describe(
            "Sources to search. Each may be a marked id from list_dialogs, a @username, or a t.me link — including channels the account has not joined.",
          ),
        folder_ids: z
          .array(z.string())
          .optional()
          .describe(
            "Folder ids from list_folders, expanded to their member sources.",
          ),
        exclude_source_ids: z
          .array(z.string())
          .optional()
          .describe(
            "Subtracted from the union of source_ids and folder_ids. Rejected without one of those, because an account-wide search cannot exclude.",
          ),
        from: z
          .string()
          .optional()
          .describe("ISO 8601. Inclusive lower bound on message date."),
        to: z
          .string()
          .optional()
          .describe("ISO 8601. Inclusive upper bound on message date."),
        media_type: z.enum(MEDIA_TYPES).optional(),
        limit: z.number().int().min(1).max(100).default(20),
        cursor: z
          .string()
          .describe(
            "Opaque continuation token from a previous response's next_cursor. Copy it back exactly as received, character for character; it is not human-readable and must not be shortened, re-typed or reconstructed. Resend the same query and filters with it.",
          )
          .optional(),
      }),
      outputSchema: z.object({
        results: z.array(
          telegramMessageSchema.extend({ source_title: z.string() }),
        ),
        sources: z.array(
          z.object({
            source_id: z.string(),
            title: z.string(),
            hit_count: z.number().int(),
            error: z
              .object({ code: z.string(), message: z.string() })
              .optional(),
          }),
        ),
        total_matches: z.number().int().optional(),
        next_cursor: z.string().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (input) => runTool("search_messages", () => searchMessages(input)),
  );
}
```

```ts
// src/mcp/server.ts — import and call, after registerGetThread(server);
import { registerSearchMessages } from "./tools/search-messages";
// ...
  registerSearchMessages(server);
```

- [ ] **Step 6: Extend the handler test to nine tools**

```ts
// tests/mcp-handler.test.ts — the name list
  it("advertises all nine tools", async () => {
    const tools = await listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "get_channel",
      "get_message",
      "get_messages",
      "get_thread",
      "get_unread_summary",
      "list_dialogs",
      "list_folders",
      "mark_read",
      "search_messages",
    ]);
  });
```

- [ ] **Step 7: Run the gates**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/mcp/tools/search-messages.ts src/mcp/server.ts src/mcp/tool-result.ts tests/logging.test.ts tests/mcp-handler.test.ts
git commit -m "feat: expose search_messages with a flat, date-ordered page"
```

---

### Task 8: `resolve_telegram_url` — turn a pasted link into something callable

Spec §6.3. The tool never joins anything. Invite links are previewed through
`messages.checkChatInvite`, which returns a title and a participant count
without joining and without a usable peer.

**Files:**
- Modify: `src/telegram/dialogs.ts` (export `fetchChannelDetails`)
- Create: `src/telegram/resolve.ts`
- Create: `src/mcp/tools/resolve-telegram-url.ts`
- Modify: `src/mcp/server.ts`
- Test: `tests/telegram-resolve.test.ts`
- Modify: `tests/mcp-handler.test.ts` (ten tools)

**Interfaces:**
- Consumes: `parseTelegramName`, `resolveSource` (Task 1); `toSource`, `foldersByPeer`, `fetchChannelDetails` from `src/telegram/dialogs.ts`; `fetchFolders`; `fetchDialogIndex`; `entityMarkedId`, `sourceType` from `src/telegram/peer-id.ts`.
- Produces:
  - `type ResolvedUrl = { kind: "source" | "post" | "invite"; source?: { source_id?: string; title: string; username?: string; type: "channel" | "group" | "chat"; subscriber_count?: number; linked_discussion_id?: string; joined: boolean; folder_ids?: string[] }; message_id?: number; comment_id?: number }`
  - `function resolveTelegramUrl(input: { url: string }): Promise<ResolvedUrl>`
  - `function registerResolveTelegramUrl(server: McpServer): void`

**One `channels.getFullChannel` per invocation, never more.** It is the only
source of `subscriber_count` for a channel the account does not hold and of
`linked_discussion_id`, and it floods after roughly twenty calls with a wait
teleproto absorbs by sleeping. This tool resolves exactly one peer, so one call
is the ceiling by construction — do not add a second for the linked group.

- [ ] **Step 1: Write the failing test**

```ts
// tests/telegram-resolve.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { resolveTelegramUrl } from "@/telegram/resolve";
import {
  __resetClientForTests,
  __setClientFactoryForTests,
} from "@/telegram/client";
import { __resetPeerCacheForTests } from "@/telegram/peer-resolve";

const HELD = "-1001111111111";

function install(options: {
  entity?: Record<string, unknown>;
  full?: unknown;
  invite?: unknown;
}) {
  const sent: string[] = [];
  __setClientFactoryForTests(async () => ({
    connected: true,
    connect: async () => true,
    getDialogs: async () => [
      {
        id: HELD,
        title: "Alpha",
        entity: { className: "Channel", id: 1111111111n, title: "Alpha" },
        dialog: { readInboxMaxId: 0 },
        unreadCount: 0,
        date: 1,
        message: { id: 1 },
      },
    ],
    getEntity: async () =>
      options.entity ?? { className: "Channel", id: 1111111111n, title: "Alpha" },
    getMessages: async () => [],
    invoke: async (request: unknown) => {
      const r = request as { className: string };
      sent.push(r.className);
      if (r.className === "messages.CheckChatInvite") return options.invite;
      if (r.className === "channels.GetFullChannel") return options.full;
      return {};
    },
  }));
  return sent;
}

afterEach(() => {
  __setClientFactoryForTests(undefined);
  __resetClientForTests();
  __resetPeerCacheForTests();
});

describe("resolveTelegramUrl", () => {
  it("resolves a channel the account already holds", async () => {
    const sent = install({
      full: {
        fullChat: { about: "a", linkedChatId: 2222222222n, participantsCount: 40 },
      },
    });
    const result = await resolveTelegramUrl({ url: "https://t.me/alpha" });

    expect(result.kind).toBe("source");
    expect(result.source).toMatchObject({
      source_id: HELD,
      title: "Alpha",
      type: "channel",
      joined: true,
      linked_discussion_id: "-1002222222222",
    });
    expect(sent.filter((c) => c === "channels.GetFullChannel")).toHaveLength(1);
  });

  it("marks a channel the account has not joined", async () => {
    install({
      entity: {
        className: "Channel",
        id: 999n,
        title: "Outside",
        username: "outside",
        participantsCount: 12345,
      },
      full: { fullChat: {} },
    });
    const result = await resolveTelegramUrl({ url: "t.me/outside" });
    expect(result.source).toMatchObject({
      source_id: "-100999",
      username: "outside",
      subscriber_count: 12345,
      joined: false,
    });
  });

  it("reads a post link, and a comment link under it", async () => {
    install({ full: { fullChat: {} } });
    const post = await resolveTelegramUrl({ url: "https://t.me/alpha/500" });
    expect(post.kind).toBe("post");
    expect(post.message_id).toBe(500);
    expect(post.comment_id).toBeUndefined();

    const comment = await resolveTelegramUrl({
      url: "https://t.me/alpha/500?comment=42",
    });
    expect(comment.kind).toBe("post");
    expect(comment.message_id).toBe(500);
    expect(comment.comment_id).toBe(42);
  });

  it("previews an invite without joining and without a peer id", async () => {
    const sent = install({
      invite: {
        className: "ChatInvite",
        title: "Private Room",
        participantsCount: 7,
        megagroup: true,
      },
    });
    const result = await resolveTelegramUrl({ url: "https://t.me/+AbCdEf" });

    expect(result.kind).toBe("invite");
    expect(result.source).toEqual({
      title: "Private Room",
      type: "group",
      subscriber_count: 7,
      joined: false,
    });
    expect(sent).toEqual(["messages.CheckChatInvite"]);
  });

  it("reports an invite the account already joined as joined", async () => {
    install({
      invite: {
        className: "ChatInviteAlready",
        chat: { className: "Channel", id: 1111111111n, title: "Alpha" },
      },
    });
    const result = await resolveTelegramUrl({ url: "t.me/joinchat/AbCdEf" });
    expect(result.kind).toBe("invite");
    expect(result.source).toMatchObject({
      source_id: HELD,
      title: "Alpha",
      joined: true,
    });
  });

  it("fails a private internal link the account cannot hold", async () => {
    __setClientFactoryForTests(async () => ({
      connected: true,
      connect: async () => true,
      getDialogs: async () => [],
      getEntity: async () => {
        throw Object.assign(new Error("x"), { errorMessage: "CHANNEL_INVALID" });
      },
      getMessages: async () => [],
      invoke: async () => ({}),
    }));
    await expect(
      resolveTelegramUrl({ url: "https://t.me/c/9999999999/12" }),
    ).rejects.toMatchObject({ code: "CHANNEL_NOT_FOUND" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/telegram-resolve.test.ts`
Expected: FAIL — `Failed to resolve import "@/telegram/resolve"`.

- [ ] **Step 3: Export the single getFullChannel call site**

```ts
// src/telegram/dialogs.ts — change the declaration only
export async function fetchChannelDetails(
  client: TelegramLike,
  entity: unknown,
): Promise<SourceDetails> {
```

- [ ] **Step 4: Write the engine**

```ts
// src/telegram/resolve.ts
import { withTelegram, getApi, type TelegramLike } from "./client";
import { fetchDialogIndex } from "./dialog-index";
import { fetchFolders } from "./folders";
import { fetchChannelDetails, foldersByPeer, toSource } from "./dialogs";
import { parseTelegramName, resolveSource } from "./peer-resolve";
import { entityMarkedId, sourceType } from "./peer-id";
import { GramScopeError } from "../errors/taxonomy";

export type ResolvedUrl = {
  kind: "source" | "post" | "invite";
  source?: {
    source_id?: string;
    title: string;
    username?: string;
    type: "channel" | "group" | "chat";
    subscriber_count?: number;
    linked_discussion_id?: string;
    joined: boolean;
    folder_ids?: string[];
  };
  message_id?: number;
  comment_id?: number;
};

/**
 * messages.checkChatInvite previews a private chat without joining it. A
 * preview carries no usable peer, so source_id is absent unless the account is
 * already a member — in which case Telegram returns the chat itself.
 */
async function previewInvite(
  client: TelegramLike,
  hash: string,
  joinedIds: Set<string>,
  folderIndex: Map<string, string[]>,
): Promise<ResolvedUrl> {
  const Api = await getApi();
  const raw = (await client.invoke(
    new Api.messages.CheckChatInvite({ hash }),
  )) as Record<string, unknown> | undefined;
  const invite = raw ?? {};

  const chat = invite.chat as Record<string, unknown> | undefined;
  if (chat) {
    // ChatInviteAlready or ChatInvitePeek: a real entity came back.
    const source = toSource(chat, folderIndex);
    return {
      kind: "invite",
      source: {
        ...(source.id ? { source_id: source.id } : {}),
        title: source.title,
        ...(source.username !== undefined ? { username: source.username } : {}),
        type: source.type,
        ...(source.subscriber_count !== undefined
          ? { subscriber_count: source.subscriber_count }
          : {}),
        joined: source.id ? joinedIds.has(source.id) : false,
        ...(source.folder_ids ? { folder_ids: source.folder_ids } : {}),
      },
    };
  }

  const title = typeof invite.title === "string" ? invite.title : "";
  const count =
    typeof invite.participantsCount === "number"
      ? invite.participantsCount
      : undefined;
  return {
    kind: "invite",
    source: {
      title,
      // An invite preview is not an entity, so sourceType cannot read it: the
      // flags are what Telegram gives here.
      type:
        invite.megagroup === true
          ? "group"
          : invite.broadcast === true || invite.channel === true
            ? "channel"
            : "chat",
      ...(count !== undefined ? { subscriber_count: count } : {}),
      joined: false,
    },
  };
}

export async function resolveTelegramUrl(input: {
  url: string;
}): Promise<ResolvedUrl> {
  const link = parseTelegramName(input.url);
  const folders = await fetchFolders();
  const folderIndex = foldersByPeer(folders);
  const index = await fetchDialogIndex();

  return withTelegram(async (client) => {
    if (link.kind === "invite") {
      return previewInvite(
        client,
        link.hash,
        new Set(index.byId.keys()),
        folderIndex,
      );
    }

    const resolved = await resolveSource(client, index, input.url);
    const entity =
      resolved.entity ?? (await client.getEntity(resolved.handle));
    if (entityMarkedId(entity) === undefined) {
      throw new GramScopeError(
        "CHANNEL_NOT_FOUND",
        `Could not resolve ${input.url} to a Telegram peer`,
      );
    }

    // The ONE getFullChannel of this call. Broadcast channels and megagroups
    // carry their subscriber count and linked group only here; a failure costs
    // those two fields, never the call.
    const details =
      sourceType(entity) === "channel" || sourceType(entity) === "group"
        ? await fetchChannelDetails(client, entity).catch(() => ({}))
        : {};

    const source = toSource(entity, folderIndex, {
      id: resolved.source_id,
      title: resolved.title,
      ...details,
    });

    return {
      kind: link.messageId !== undefined ? "post" : "source",
      source: {
        source_id: source.id,
        title: source.title,
        ...(source.username !== undefined ? { username: source.username } : {}),
        type: source.type,
        ...(source.subscriber_count !== undefined
          ? { subscriber_count: source.subscriber_count }
          : {}),
        ...(source.linked_discussion_id !== undefined
          ? { linked_discussion_id: source.linked_discussion_id }
          : {}),
        joined: index.byId.has(source.id),
        ...(source.folder_ids ? { folder_ids: source.folder_ids } : {}),
      },
      ...(link.messageId !== undefined ? { message_id: link.messageId } : {}),
      ...(link.commentId !== undefined ? { comment_id: link.commentId } : {}),
    };
  });
}
```

- [ ] **Step 5: Run the engine test to verify it passes**

Run: `npx vitest run tests/telegram-resolve.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Register the tool**

```ts
// src/mcp/tools/resolve-telegram-url.ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { resolveTelegramUrl } from "../../telegram/resolve";
import { runTool } from "../tool-result";

export function registerResolveTelegramUrl(server: McpServer): void {
  server.registerTool(
    "resolve_telegram_url",
    {
      title: "Resolve a Telegram link",
      description:
        "Turn a Telegram link, @username or bare name into something the other tools can call. Accepts t.me/name, t.me/name/123, t.me/name/123?comment=456, t.me/c/<id>/<msg>, t.me/+hash and t.me/joinchat/hash. kind says what the link points at: a source, a specific post, or an invite. joined says whether the account is a member — it does NOT have to be for get_messages, get_thread or search_messages to read a public channel, so a resolved source_id or @username can be passed straight to them. An invite preview has no source_id and cannot be read; joining is not supported. A t.me/c/ link resolves only for chats the account is already in. This tool never joins anything and changes nothing.",
      inputSchema: z.object({
        url: z
          .string()
          .min(1)
          .describe("A t.me link, a @username, or a bare channel name."),
      }),
      outputSchema: z.object({
        kind: z.enum(["source", "post", "invite"]),
        source: z
          .object({
            source_id: z.string().optional(),
            title: z.string(),
            username: z.string().optional(),
            type: z.enum(["channel", "group", "chat"]),
            subscriber_count: z.number().int().optional(),
            linked_discussion_id: z.string().optional(),
            joined: z.boolean(),
            folder_ids: z.array(z.string()).optional(),
          })
          .optional(),
        message_id: z.number().int().optional(),
        comment_id: z.number().int().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      runTool("resolve_telegram_url", () => resolveTelegramUrl(input)),
  );
}
```

```ts
// src/mcp/server.ts — import and call, after registerSearchMessages(server);
import { registerResolveTelegramUrl } from "./tools/resolve-telegram-url";
// ...
  registerResolveTelegramUrl(server);
```

- [ ] **Step 7: Extend the handler test to ten tools**

Add `"resolve_telegram_url"` to the sorted name list and rename the test to
"advertises all ten tools". The sorted position is after `mark_read` and before
`search_messages`.

- [ ] **Step 8: Run the gates**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add src/telegram/resolve.ts src/telegram/dialogs.ts src/mcp/tools/resolve-telegram-url.ts src/mcp/server.ts tests/telegram-resolve.test.ts tests/mcp-handler.test.ts
git commit -m "feat: expose resolve_telegram_url for links, usernames and invites"
```

### Task 9: `get_pinned_messages`

Spec §6.4. One source, `messages.search` with `InputMessagesFilterPinned` and an
empty query, newest first. A source with nothing pinned returns an empty list.

**Files:**
- Create: `src/telegram/pinned.ts`
- Create: `src/mcp/tools/get-pinned-messages.ts`
- Modify: `src/mcp/server.ts`
- Test: `tests/telegram-pinned.test.ts`
- Modify: `tests/mcp-handler.test.ts` (eleven tools, and the mutating-tool test)

**Interfaces:**
- Consumes: `resolveSource` (Task 1); `readMessagesPage` (Task 3); `encodePinnedCursor` / `decodePinnedCursor` / `scopeFingerprint` / `assertSameScope` (Task 2); `fitToSizeCap`; `mapMessage`.
- Produces:
  - `type GetPinnedInput = { source_id: string; limit: number; cursor?: string }`
  - `type GetPinnedResult = { source_id: string; source_title: string; messages: TelegramMessage[]; next_cursor?: string }`
  - `function getPinnedMessages(input: GetPinnedInput): Promise<GetPinnedResult>`
  - `function registerGetPinnedMessages(server: McpServer): void`

- [ ] **Step 1: Write the failing test**

```ts
// tests/telegram-pinned.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { getPinnedMessages } from "@/telegram/pinned";
import {
  __resetClientForTests,
  __setClientFactoryForTests,
} from "@/telegram/client";
import { __resetPeerCacheForTests } from "@/telegram/peer-resolve";
import { decodePinnedCursor } from "@/pagination";

const A = "-1001111111111";

function install(reply: unknown) {
  const sent: Array<Record<string, unknown>> = [];
  __setClientFactoryForTests(async () => ({
    connected: true,
    connect: async () => true,
    getDialogs: async () => [
      {
        id: A,
        title: "Alpha",
        entity: { className: "Channel", id: 1111111111n, title: "Alpha" },
        dialog: { readInboxMaxId: 700 },
        unreadCount: 0,
        date: 1,
        message: { id: 900 },
      },
    ],
    getEntity: async () => ({ className: "Channel", id: 1111111111n }),
    getMessages: async () => [],
    invoke: async (request: unknown) => {
      sent.push({ ...(request as Record<string, unknown>) });
      return reply;
    },
  }));
  return sent;
}

afterEach(() => {
  __setClientFactoryForTests(undefined);
  __resetClientForTests();
  __resetPeerCacheForTests();
});

describe("getPinnedMessages", () => {
  it("asks Telegram for pinned messages only", async () => {
    const sent = install({
      className: "messages.MessagesSlice",
      count: 2,
      messages: [
        { className: "Message", id: 800, date: 1_750_000_100, message: "pinned" },
      ],
      chats: [],
      users: [],
    });
    const page = await getPinnedMessages({ source_id: A, limit: 20 });

    expect(sent[0]!.className).toBe("messages.Search");
    expect(sent[0]!.q).toBe("");
    expect(
      (sent[0]!.filter as { className: string }).className,
    ).toBe("InputMessagesFilterPinned");
    expect(page.source_id).toBe(A);
    expect(page.source_title).toBe("Alpha");
    expect(page.messages.map((m) => m.id)).toEqual([800]);
    expect(page.messages[0]!.is_read).toBe(false);
    expect(page.next_cursor).toBeUndefined();
  });

  it("returns an empty list when nothing is pinned", async () => {
    install({ className: "messages.Messages", messages: [], chats: [], users: [] });
    const page = await getPinnedMessages({ source_id: A, limit: 20 });
    expect(page.messages).toEqual([]);
    expect(page.next_cursor).toBeUndefined();
  });

  it("cursors below the oldest pinned message when the page filled up", async () => {
    install({
      className: "messages.MessagesSlice",
      count: 9,
      messages: [
        { className: "Message", id: 800, date: 1_750_000_200 },
        { className: "Message", id: 700, date: 1_750_000_100 },
      ],
      chats: [],
      users: [],
    });
    const page = await getPinnedMessages({ source_id: A, limit: 2 });
    expect(decodePinnedCursor(page.next_cursor!).offsetId).toBe(700);
  });

  it("rejects a cursor issued for another source", async () => {
    install({
      className: "messages.MessagesSlice",
      count: 9,
      messages: [
        { className: "Message", id: 800, date: 1_750_000_200 },
        { className: "Message", id: 700, date: 1_750_000_100 },
      ],
      chats: [],
      users: [],
    });
    const page = await getPinnedMessages({ source_id: A, limit: 2 });
    await expect(
      getPinnedMessages({
        source_id: "-1009999999999",
        limit: 2,
        cursor: page.next_cursor!,
      }),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/telegram-pinned.test.ts`
Expected: FAIL — `Failed to resolve import "@/telegram/pinned"`.

- [ ] **Step 3: Write the engine**

```ts
// src/telegram/pinned.ts
import { getApi, withTelegram } from "./client";
import { fetchDialogIndex } from "./dialog-index";
import { resolveSource } from "./peer-resolve";
import { readMessagesPage } from "./tl-messages";
import {
  assertSameScope,
  decodePinnedCursor,
  encodePinnedCursor,
  scopeFingerprint,
} from "../pagination";
import { fitToSizeCap } from "../schemas/size";
import {
  mapMessage,
  type MessageContext,
  type TelegramMessage,
} from "../schemas/message";

export type GetPinnedInput = {
  source_id: string;
  limit: number;
  cursor?: string;
};

export type GetPinnedResult = {
  source_id: string;
  source_title: string;
  messages: TelegramMessage[];
  next_cursor?: string;
};

export async function getPinnedMessages(
  input: GetPinnedInput,
): Promise<GetPinnedResult> {
  const index = await fetchDialogIndex();

  return withTelegram(async (client) => {
    const source = await resolveSource(client, index, input.source_id);
    const fingerprint = scopeFingerprint({ source: source.source_id });
    const cursor = input.cursor ? decodePinnedCursor(input.cursor) : undefined;
    if (cursor) assertSameScope(cursor.fingerprint, fingerprint);

    const Api = await getApi();
    // messages.getHistory cannot filter, so the pinned tab is a search with an
    // empty query — the same primitive the Telegram app uses.
    const page = readMessagesPage(
      await client.invoke(
        new Api.messages.Search({
          peer: source.handle as never,
          q: "",
          filter: new Api.InputMessagesFilterPinned() as never,
          minDate: 0,
          maxDate: 0,
          offsetId: cursor?.offsetId ?? 0,
          addOffset: 0,
          limit: input.limit,
          maxId: 0,
          minId: 0,
          hash: 0 as never,
        }),
      ),
    );

    const entry = index.byId.get(source.source_id);
    const context: MessageContext = {
      chatId: source.source_id,
      ...(source.username !== undefined ? { username: source.username } : {}),
      ...(entry !== undefined
        ? { readInboxMaxId: entry.read_inbox_max_id }
        : {}),
    };

    const base = {
      source_id: source.source_id,
      source_title: source.title,
    };
    const all = page.messages.map((raw) => mapMessage(raw, context));
    const messages = all.slice(
      0,
      fitToSizeCap(all, (kept) => ({ ...base, messages: kept })),
    );

    const exhausted =
      messages.length === all.length && all.length < input.limit;
    const oldest = messages[messages.length - 1];

    return {
      ...base,
      messages,
      ...(exhausted || oldest === undefined
        ? {}
        : {
            next_cursor: encodePinnedCursor({
              offsetId: oldest.id,
              fingerprint,
            }),
          }),
    };
  });
}
```

- [ ] **Step 4: Run the engine test to verify it passes**

Run: `npx vitest run tests/telegram-pinned.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Register the tool**

```ts
// src/mcp/tools/get-pinned-messages.ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { getPinnedMessages } from "../../telegram/pinned";
import { telegramMessageSchema } from "../../schemas/message";
import { runTool } from "../tool-result";

export function registerGetPinnedMessages(server: McpServer): void {
  server.registerTool(
    "get_pinned_messages",
    {
      title: "Read a source's pinned messages",
      description:
        "Read the pinned messages of one Telegram source, newest first. Pinned posts are usually a channel's rules, its navigation, or the announcement it wants read first, so this is the cheapest way to learn what a source is about. The source may be named by marked id, @username, or t.me link, including a public channel the account has not joined. A source with nothing pinned returns an empty list, not an error. Read-only.",
      inputSchema: z.object({
        source_id: z
          .string()
          .describe("A marked id, a @username, or a t.me link."),
        limit: z.number().int().min(1).max(100).default(20),
        cursor: z
          .string()
          .describe(
            "Opaque continuation token from a previous response's next_cursor. Copy it back exactly as received, character for character; it is not human-readable and must not be shortened, re-typed or reconstructed. It is bound to this source_id.",
          )
          .optional(),
      }),
      outputSchema: z.object({
        source_id: z.string(),
        source_title: z.string(),
        messages: z.array(telegramMessageSchema),
        next_cursor: z.string().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      runTool("get_pinned_messages", () => getPinnedMessages(input)),
  );
}
```

```ts
// src/mcp/server.ts — import and call, after registerResolveTelegramUrl(server);
import { registerGetPinnedMessages } from "./tools/get-pinned-messages";
// ...
  registerGetPinnedMessages(server);
```

- [ ] **Step 6: Take the handler test to eleven tools**

```ts
// tests/mcp-handler.test.ts — the name list, sorted
  it("advertises all eleven tools", async () => {
    const tools = await listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "get_channel",
      "get_message",
      "get_messages",
      "get_pinned_messages",
      "get_thread",
      "get_unread_summary",
      "list_dialogs",
      "list_folders",
      "mark_read",
      "resolve_telegram_url",
      "search_messages",
    ]);
  });
```

The existing "marks only mark_read as mutating" test needs no edit — it derives
the expectation from the name — but confirm it still passes, since it is what
asserts `readOnlyHint: true` on all four new tools.

- [ ] **Step 7: Run the gates**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: all green, eleven tools listed, ten of them read-only.

- [ ] **Step 8: Commit**

```bash
git add src/telegram/pinned.ts src/mcp/tools/get-pinned-messages.ts src/mcp/server.ts tests/telegram-pinned.test.ts tests/mcp-handler.test.ts
git commit -m "feat: expose get_pinned_messages"
```

---

### Task 10: Let the reading tools read sources the account has not joined

Spec §10. Without this a resolved link is a dead end: the model could search a
channel it cannot page. The asymmetry is worse than either extreme.

A source outside the dialog index has no folder membership, no unread count and
no read pointer, so `is_read` is absent for its messages and it can never be
reached through `folder_ids` — only by being named.

**Files:**
- Modify: `src/pagination.ts` (rename `MessageCursor.sources[].sourceId` to `handle`)
- Modify: `src/telegram/message-slice.ts` (`SliceRequest.handle`)
- Modify: `src/telegram/messages.ts`
- Modify: `tests/pagination.test.ts`, `tests/telegram-messages.test.ts`, `tests/telegram-message-slice.test.ts`

**Interfaces:**
- Consumes: `resolveSource` (Task 1).
- Produces (changed signatures other tasks do not depend on, but sub-project 2 code does):
  - `type MessageCursor = { sources: Array<{ handle: string; offsetId: number }> }`
  - `type SliceRequest` gains `handle?: string`
  - `resolveSourceSet(input, index): Array<{ handle: string; offsetId: number }>`
  - `type Fetched` gains `handle: string`

The cursor field is renamed rather than reused because it no longer holds a
marked id: a channel resolved by username must keep travelling by username, or
a fresh serverless instance resumes with a bare id that Telegram answers
`CHANNEL_INVALID`. The wire payload key stays `i`, so cursors already issued
keep decoding.

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/telegram-messages.test.ts
describe("sources outside the dialog index", () => {
  it("reads a channel named by username and keeps the username in the cursor", async () => {
    __setClientFactoryForTests(async () => ({
      connected: true,
      connect: async () => true,
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

  it("accepts a t.me link in get_message", async () => {
    __setClientFactoryForTests(async () => ({
      connected: true,
      connect: async () => true,
      getDialogs: async () => [],
      getEntity: async () => ({
        className: "Channel",
        id: 999n,
        title: "Outside",
        username: "outside",
      }),
      getMessages: async () => [
        { className: "Message", id: 5, date: 1_750_000_000, message: "hi" },
      ],
    }));

    const detail = await getMessage({
      source_id: "https://t.me/outside/5",
      message_id: 5,
    });
    expect(detail.source_id).toBe("-100999");
    expect(detail.source_title).toBe("Outside");
    expect(detail.message.id).toBe(5);
  });
});
```

Add `__resetPeerCacheForTests()` to the existing `afterEach` in this file, so a
resolution memoized by one test cannot answer another.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/telegram-messages.test.ts`
Expected: FAIL — the username is passed to Telegram as-is and the block reports
`source_id: "@outside"`.

- [ ] **Step 3: Rename the cursor field**

```ts
// src/pagination.ts
export type MessageCursor = {
  /**
   * A HANDLE, not necessarily a marked id: a username when the source has one.
   * A bare marked id resolves only for peers the account holds, so a channel
   * reached by username must keep travelling by username across cold
   * instances. The wire key stays `i`, so older cursors still decode.
   */
  sources: Array<{ handle: string; offsetId: number }>;
};
// ...encode: i: source.handle
// ...decode: handle: source.i
```

Update the three `{ sourceId, offsetId }` literals in `tests/pagination.test.ts`
to `{ handle, offsetId }`.

- [ ] **Step 4: Let a slice be read by a handle**

```ts
// src/telegram/message-slice.ts — in SliceRequest, after sourceId
  /** What to pass to teleproto when it differs from the marked id. */
  handle?: string;
// ...in fetchSlice, replace the entity argument
  const raw = await client.getMessages(request.handle ?? request.sourceId, {
```

- [ ] **Step 5: Route every source name through peer-resolve**

```ts
// src/telegram/messages.ts — the changed parts

// resolveSourceSet: rename the produced field only.
export function resolveSourceSet(
  input: GetMessagesInput,
  index: DialogIndex,
): Array<{ handle: string; offsetId: number }> {
  // ...unchanged body, with:
  //   resolved = decodeMessageCursor(input.cursor).sources;
  //   resolved = ordered.map((handle) => ({ handle, offsetId: 0 }));
}

export type Fetched = {
  source_id: string;
  title: string;
  /** What the cursor stores for this block; see MessageCursor. */
  handle: string;
  startOffsetId: number;
  slice?: Slice;
  error?: { code: string; message: string };
};

// compose(): every unexhausted.push becomes
//   unexhausted.push({ handle: block.handle, offsetId: ... });

// getMessages(): inside the fan-out
    mapWithConcurrency(targets, FANOUT_CONCURRENCY, async (target) => {
      let source;
      try {
        source = await resolveSource(client, index, target.handle);
      } catch (err) {
        // An unresolvable name is this source's failure, not the page's.
        const mapped = mapTelegramError(err);
        return {
          source_id: target.handle,
          title: target.handle,
          handle: target.handle,
          startOffsetId: target.offsetId,
          error: { code: mapped.code, message: mapped.message },
        } satisfies Fetched;
      }

      const entry = index.byId.get(source.source_id);
      try {
        const slice = await fetchSlice(client, {
          sourceId: source.source_id,
          handle: source.handle,
          ...(source.username !== undefined
            ? { username: source.username }
            : {}),
          ...(entry !== undefined
            ? { readInboxMaxId: entry.read_inbox_max_id }
            : {}),
          limit: input.limit,
          offsetId: target.offsetId,
          ...(fromSeconds !== undefined ? { fromSeconds } : {}),
          ...(toSeconds !== undefined ? { toSeconds } : {}),
          ...(input.unread_only === true ? { unreadOnly: true } : {}),
          ...(input.media_type !== undefined
            ? { mediaType: input.media_type }
            : {}),
        });
        return {
          source_id: source.source_id,
          title: source.title,
          handle: source.handle,
          startOffsetId: target.offsetId,
          slice,
        } satisfies Fetched;
      } catch (err) {
        // Spec §11: one dead channel must not cost a digest.
        const mapped = mapTelegramError(err);
        return {
          source_id: source.source_id,
          title: source.title,
          handle: source.handle,
          startOffsetId: target.offsetId,
          error: { code: mapped.code, message: mapped.message },
        } satisfies Fetched;
      }
    }),

// getMessage(): resolve first, then read by handle
export async function getMessage(
  input: GetMessageInput,
): Promise<GetMessageResult> {
  // ...the context_before/context_after bounds check is unchanged

  const index = await fetchDialogIndex();

  return withTelegram(async (client) => {
    const source = await resolveSource(client, index, input.source_id);
    const entry = index.byId.get(source.source_id);
    const ctx: MessageContext = {
      chatId: source.source_id,
      ...(source.username !== undefined ? { username: source.username } : {}),
      ...(entry !== undefined
        ? { readInboxMaxId: entry.read_inbox_max_id }
        : {}),
    };

    const found = await client.getMessages(source.handle, {
      ids: [input.message_id],
    });
    // ...the MESSAGE_NOT_FOUND guard is unchanged except for its message,
    //    which names source.source_id

    const older =
      before > 0
        ? await client.getMessages(source.handle, {
            limit: before,
            offsetId: input.message_id,
          })
        : [];
    const newer =
      after > 0
        ? await client.getMessages(source.handle, {
            limit: after,
            offsetId: input.message_id,
            addOffset: -after,
          })
        : [];

    // ...toAscending is unchanged

    return {
      source_id: source.source_id,
      source_title: source.title,
      message: mapMessage(target, ctx),
      context_before: toAscending(older),
      context_after: toAscending(newer),
    };
  });
}
```

Note that `getMessage` moves `fetchDialogIndex` outside `withTelegram` exactly
as `getMessages` already does, and that the whole body now runs inside
`withTelegram` so resolution errors are mapped by the same boundary.

- [ ] **Step 6: Widen the two tool descriptions**

```ts
// src/mcp/tools/get-messages.ts — source_ids describe()
            "Sources to read. Each may be a marked id from list_dialogs, a @username, or a t.me link — including a public channel the account has not joined, which then reports no unread state.",
// src/mcp/tools/get-message.ts — source_id describe()
            "A marked id from list_dialogs, a @username, or a t.me link.",
```

Read `src/mcp/tools/get-message.ts` before editing it; the wording above
replaces whatever that parameter's current `.describe()` says.

- [ ] **Step 7: Run the gates**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: all green. `tests/telegram-messages.test.ts` and
`tests/pagination.test.ts` were both edited, so watch that the pre-existing
fan-out and cursor tests still pass.

- [ ] **Step 8: Commit**

```bash
git add src/pagination.ts src/telegram/message-slice.ts src/telegram/messages.ts src/mcp/tools/get-messages.ts src/mcp/tools/get-message.ts tests/pagination.test.ts tests/telegram-messages.test.ts tests/telegram-message-slice.test.ts
git commit -m "feat: read sources the account has not joined in get_messages and get_message"
```

## Resume note

Planning is in progress in this file. The tasks are appended in order, and each
append is its own commit, so `git log -- docs/superpowers/plans/2026-08-27-gramscope-research.md`
shows exactly how far planning got. Planning is finished when this note is
replaced by the "Plan complete" line. If you are picking this up cold: read the
spec first, then the tasks already present, then continue numbering from the
last one written.
