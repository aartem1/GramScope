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

## Resume note

Planning is in progress in this file. The tasks are appended in order, and each
append is its own commit, so `git log -- docs/superpowers/plans/2026-08-27-gramscope-research.md`
shows exactly how far planning got. Planning is finished when this note is
replaced by the "Plan complete" line. If you are picking this up cold: read the
spec first, then the tasks already present, then continue numbering from the
last one written.
