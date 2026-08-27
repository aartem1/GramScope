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

## Resume note

Planning is in progress in this file. The tasks are appended in order, and each
append is its own commit, so `git log -- docs/superpowers/plans/2026-08-27-gramscope-research.md`
shows exactly how far planning got. Planning is finished when this note is
replaced by the "Plan complete" line. If you are picking this up cold: read the
spec first, then the tasks already present, then continue numbering from the
last one written.
