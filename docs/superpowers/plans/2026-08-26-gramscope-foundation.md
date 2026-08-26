# GramScope Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy an OAuth-protected MCP server on Vercel that exposes three read-only tools — `list_dialogs`, `list_folders`, `get_channel` — over the owner's dedicated Telegram account.

**Architecture:** Next.js App Router with two routes: the MCP handler and an RFC 9728 protected-resource document. All MTProto access funnels through a single `withTelegram()` helper that owns connection reuse and error translation; tools are thin mappers over a `src/telegram` layer and never import a Telegram client directly.

**Tech Stack:** TypeScript, Next.js (App Router), `mcp-handler` ^2.1.1, `@modelcontextprotocol/server` ^2.0.0, `teleproto` ^1.229.0, `zod`, `jose`, Vitest, WorkOS AuthKit, Vercel.

**Spec:** `docs/superpowers/specs/2026-08-26-gramscope-foundation-design.md`

## Global Constraints

- Branch: `gramscope-mcp`. Never commit to `main`.
- Node.js 20+.
- MCP peer dependency is `@modelcontextprotocol/server` ^2.0.0, **not** `@modelcontextprotocol/sdk`. `mcp-handler` ^2.1.1 declares it as a peer alongside `next` >=13.
- Secrets (`TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION`, `WORKOS_*`, `OWNER_USER_ID`) live in gitignored `.env.local` and Vercel env vars. Never in chat, commits, source, tests, fixtures, or logs. The StringSession grants full account access and is never printed.
- Every tool declares `annotations: { readOnlyHint: true }`. No tool in this sub-project writes Telegram state.
- Every paginated response is capped at 256 KB of serialized `structuredContent`; over the cap, return fewer items plus `next_cursor` rather than truncating an item.
- `list_dialogs` max `limit` is 200, default 50.
- No tool may import `teleproto` directly. Only `src/telegram/client.ts` does.

**Terminology trap — read before writing any folder code.** Telegram has two unrelated concepts that both get called "folder":
- **Peer folder** — the archive. `Dialog.folderId` is `0` (main) or `1` (archive), and `IterDialogsParams.folder` / `.archived` select it. This is *not* what the spec means by folders.
- **Dialog filter** — the chat-folder tabs the user sees. Fetched via `Api.messages.GetDialogFilters`. This *is* what `list_folders` and `list_dialogs(folder_id)` mean.

Two further shape traps confirmed against `teleproto` 1.229.0 types:
- `messages.GetDialogFilters` returns `messages.DialogFilters` — an object with a `.filters` array, not a bare array.
- `.filters` is a union: `DialogFilter` (has `id`, `title`, `includePeers`, `excludePeers`, flags), `DialogFilterChatlist` (has `id`, `title`, `includePeers`, but **no** `excludePeers`), and `DialogFilterDefault` (the "All chats" pseudo-entry — **no `id`, no `title`**; must be skipped).
- `title` is `Api.TextWithEntities`, not a string. Read `title.text`.

---

### Task 1: Project skeleton, gates, and branch

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `.gitignore`, `.env.example`, `eslint.config.mjs`
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `loadConfig(env?: Record<string, string | undefined>): Config` from `src/config.ts`, where
  `type Config = { telegramApiId: number; telegramApiHash: string; telegramSession: string; workosIssuer: string; workosJwksUrl: string; ownerUserId: string }`.
  Throws `Error` naming the missing variable when any is absent.

- [ ] **Step 1: Create the branch**

```bash
git checkout -b gramscope-mcp
```

- [ ] **Step 2: Scaffold the project files**

`package.json`:

```json
{
  "name": "gramscope",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "test": "vitest run --exclude '**/*.live.test.ts'",
    "test:live": "vitest run tests/live",
    "telegram:login": "tsx scripts/create-telegram-session.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/server": "^2.0.0",
    "mcp-handler": "^2.1.1",
    "next": "^15.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "teleproto": "^1.229.0",
    "jose": "^5.9.0",
    "zod": "^4.2.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/react": "^19.0.0",
    "eslint": "^9.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "jsx": "preserve",
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] },
    "baseUrl": "."
  },
  "include": ["**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

`vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
```

`.gitignore`:

```
node_modules/
.next/
.env
.env.local
*.session
```

`.env.example` (names only — never real values):

```
TELEGRAM_API_ID=
TELEGRAM_API_HASH=
TELEGRAM_SESSION=
WORKOS_ISSUER=
WORKOS_JWKS_URL=
OWNER_USER_ID=
```

`next.config.ts`:

```typescript
import type { NextConfig } from "next";
const nextConfig: NextConfig = {};
export default nextConfig;
```

`eslint.config.mjs`:

```javascript
export default [{ ignores: [".next/", "node_modules/"] }];
```

- [ ] **Step 3: Write the failing test**

`tests/config.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { loadConfig } from "@/config";

const complete = {
  TELEGRAM_API_ID: "12345",
  TELEGRAM_API_HASH: "abc",
  TELEGRAM_SESSION: "sess",
  WORKOS_ISSUER: "https://auth.example.com",
  WORKOS_JWKS_URL: "https://auth.example.com/jwks",
  OWNER_USER_ID: "user_123",
};

describe("loadConfig", () => {
  it("parses a complete environment", () => {
    const config = loadConfig(complete);
    expect(config.telegramApiId).toBe(12345);
    expect(config.ownerUserId).toBe("user_123");
  });

  it("names the missing variable", () => {
    const { OWNER_USER_ID, ...partial } = complete;
    expect(() => loadConfig(partial)).toThrow(/OWNER_USER_ID/);
  });

  it("rejects a non-numeric api id", () => {
    expect(() =>
      loadConfig({ ...complete, TELEGRAM_API_ID: "nope" }),
    ).toThrow(/TELEGRAM_API_ID/);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm test -- tests/config.test.ts`
Expected: FAIL — cannot resolve `@/config`.

- [ ] **Step 5: Write the minimal implementation**

`src/config.ts`:

```typescript
export type Config = {
  telegramApiId: number;
  telegramApiHash: string;
  telegramSession: string;
  workosIssuer: string;
  workosJwksUrl: string;
  ownerUserId: string;
};

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function loadConfig(env: Env = process.env): Config {
  const rawApiId = required(env, "TELEGRAM_API_ID");
  const telegramApiId = Number(rawApiId);
  if (!Number.isInteger(telegramApiId)) {
    throw new Error("TELEGRAM_API_ID must be an integer");
  }
  return {
    telegramApiId,
    telegramApiHash: required(env, "TELEGRAM_API_HASH"),
    telegramSession: required(env, "TELEGRAM_SESSION"),
    workosIssuer: required(env, "WORKOS_ISSUER"),
    workosJwksUrl: required(env, "WORKOS_JWKS_URL"),
    ownerUserId: required(env, "OWNER_USER_ID"),
  };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test -- tests/config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Verify the gates run**

Run: `npm run typecheck && npm run lint`
Expected: both exit 0.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: scaffold project, gates, and config loader"
```

---

### Task 2: Error taxonomy and MTProto mapping

**Files:**
- Create: `src/errors/taxonomy.ts`
- Create: `src/errors/from-telegram.ts`
- Test: `tests/errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ErrorCode` and `const ERROR_CODES` from `src/errors/taxonomy.ts`.
  - `class GramScopeError extends Error { code: ErrorCode; retryAfterSeconds?: number; toStructured(): { code: ErrorCode; message: string; retry_after_seconds?: number } }`
  - `mapTelegramError(err: unknown): GramScopeError` from `src/errors/from-telegram.ts`.

- [ ] **Step 1: Write the failing test**

`tests/errors.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { GramScopeError } from "@/errors/taxonomy";
import { mapTelegramError } from "@/errors/from-telegram";

class FakeRpcError extends Error {
  constructor(
    public errorMessage: string,
    public code?: number,
  ) {
    super(errorMessage);
  }
}

describe("mapTelegramError", () => {
  it("maps FLOOD_WAIT_42 to RATE_LIMITED with retry seconds", () => {
    const mapped = mapTelegramError(new FakeRpcError("FLOOD_WAIT_42", 420));
    expect(mapped.code).toBe("RATE_LIMITED");
    expect(mapped.retryAfterSeconds).toBe(42);
    expect(mapped.toStructured().retry_after_seconds).toBe(42);
  });

  it("maps CHANNEL_INVALID to CHANNEL_NOT_FOUND", () => {
    expect(mapTelegramError(new FakeRpcError("CHANNEL_INVALID", 400)).code).toBe(
      "CHANNEL_NOT_FOUND",
    );
  });

  it("maps CHANNEL_PRIVATE to PRIVATE_CHANNEL_NOT_ACCESSIBLE", () => {
    expect(mapTelegramError(new FakeRpcError("CHANNEL_PRIVATE", 400)).code).toBe(
      "PRIVATE_CHANNEL_NOT_ACCESSIBLE",
    );
  });

  it("maps AUTH_KEY_UNREGISTERED to AUTH_REQUIRED", () => {
    expect(
      mapTelegramError(new FakeRpcError("AUTH_KEY_UNREGISTERED", 401)).code,
    ).toBe("AUTH_REQUIRED");
  });

  it("passes a GramScopeError through unchanged", () => {
    const original = new GramScopeError("INVALID_CURSOR", "bad cursor");
    expect(mapTelegramError(original)).toBe(original);
  });

  it("falls back to INTERNAL_ERROR for unknown failures", () => {
    expect(mapTelegramError(new Error("something else")).code).toBe(
      "INTERNAL_ERROR",
    );
  });

  it("never leaks the original message for unknown failures", () => {
    const mapped = mapTelegramError(new Error("session=SECRETVALUE"));
    expect(mapped.message).not.toContain("SECRETVALUE");
  });

  it("passes through an unmapped but well-formed Telegram code", () => {
    const mapped = mapTelegramError(new FakeRpcError("SOME_UNKNOWN_ERROR", 400));
    expect(mapped.code).toBe("INTERNAL_ERROR");
    expect(mapped.message).toContain("SOME_UNKNOWN_ERROR");
  });

  it("never echoes an errorMessage that is free text rather than a code", () => {
    const mapped = mapTelegramError(
      new FakeRpcError("unexpected: session=SECRETVALUE", 500),
    );
    expect(mapped.code).toBe("INTERNAL_ERROR");
    expect(mapped.message).not.toContain("SECRETVALUE");
  });

  it("does not resolve inherited Object.prototype names as error codes", () => {
    for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
      const mapped = mapTelegramError(new FakeRpcError(name, 400));
      expect(typeof mapped.code).toBe("string");
      expect(mapped.code).toBe("INTERNAL_ERROR");
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/errors.test.ts`
Expected: FAIL — cannot resolve `@/errors/taxonomy`.

- [ ] **Step 3: Write the taxonomy**

`src/errors/taxonomy.ts`:

```typescript
export const ERROR_CODES = [
  "CHANNEL_NOT_FOUND",
  "PRIVATE_CHANNEL_NOT_ACCESSIBLE",
  "NOT_A_MEMBER",
  "RATE_LIMITED",
  "AUTH_REQUIRED",
  "OWNER_FORBIDDEN",
  "INVALID_DATE_RANGE",
  "INVALID_CURSOR",
  "INVALID_INPUT",
  "MESSAGE_NOT_FOUND",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type StructuredError = {
  code: ErrorCode;
  message: string;
  retry_after_seconds?: number;
};

export class GramScopeError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "GramScopeError";
  }

  toStructured(): StructuredError {
    return {
      code: this.code,
      message: this.message,
      ...(this.retryAfterSeconds !== undefined
        ? { retry_after_seconds: this.retryAfterSeconds }
        : {}),
    };
  }
}
```

- [ ] **Step 4: Write the mapper**

`src/errors/from-telegram.ts`:

```typescript
import { GramScopeError, type ErrorCode } from "./taxonomy";

// Real MTProto error codes are conventionally UPPER_SNAKE_CASE. Anything that
// does not match this shape is free text, which may embed a session string,
// and is never echoed back to the caller.
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

const EXACT: Record<string, ErrorCode> = {
  CHANNEL_INVALID: "CHANNEL_NOT_FOUND",
  CHANNEL_PRIVATE: "PRIVATE_CHANNEL_NOT_ACCESSIBLE",
  USERNAME_INVALID: "CHANNEL_NOT_FOUND",
  USERNAME_NOT_OCCUPIED: "CHANNEL_NOT_FOUND",
  PEER_ID_INVALID: "CHANNEL_NOT_FOUND",
  MSG_ID_INVALID: "MESSAGE_NOT_FOUND",
  AUTH_KEY_UNREGISTERED: "AUTH_REQUIRED",
  SESSION_REVOKED: "AUTH_REQUIRED",
  SESSION_EXPIRED: "AUTH_REQUIRED",
  USER_NOT_PARTICIPANT: "NOT_A_MEMBER",
};

function telegramMessage(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const candidate = (err as { errorMessage?: unknown }).errorMessage;
  return typeof candidate === "string" ? candidate : undefined;
}

export function mapTelegramError(err: unknown): GramScopeError {
  if (err instanceof GramScopeError) return err;

  const raw = telegramMessage(err);
  if (raw) {
    const flood = /^FLOOD_WAIT_(\d+)$/.exec(raw);
    if (flood) {
      const seconds = Number(flood[1]);
      return new GramScopeError(
        "RATE_LIMITED",
        `Telegram rate limit; retry after ${seconds}s`,
        seconds,
      );
    }
    // Object.hasOwn, not `EXACT[raw]`: a bare index lookup resolves inherited
    // Object.prototype members, so errorMessage "constructor" would return a
    // function where an ErrorCode is declared.
    if (Object.hasOwn(EXACT, raw)) {
      return new GramScopeError(EXACT[raw]!, `Telegram error: ${raw}`);
    }
    if (SAFE_CODE.test(raw)) {
      return new GramScopeError("INTERNAL_ERROR", `Telegram error: ${raw}`);
    }
    return new GramScopeError("INTERNAL_ERROR", "Unexpected internal error");
  }

  // Unknown failure: the original message may embed secrets, so it is dropped.
  return new GramScopeError("INTERNAL_ERROR", "Unexpected internal error");
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- tests/errors.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add error taxonomy and MTProto error mapping"
```

---

### Task 3: Opaque cursors

**Files:**
- Create: `src/pagination.ts`
- Test: `tests/pagination.test.ts`

**Interfaces:**
- Consumes: `GramScopeError` from `src/errors/taxonomy.ts`.
- Produces: from `src/pagination.ts`:
  - `type DialogCursor = { offsetDate: number; offsetId: number }`
  - `encodeCursor(cursor: DialogCursor): string`
  - `decodeCursor(raw: string): DialogCursor` — throws `GramScopeError("INVALID_CURSOR", …)`
  - `const CURSOR_VERSION = 1`

- [ ] **Step 1: Write the failing test**

`tests/pagination.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, type DialogCursor } from "@/pagination";
import { GramScopeError } from "@/errors/taxonomy";

const cursor: DialogCursor = {
  offsetDate: 1735689600,
  offsetId: 42,
};

describe("cursors", () => {
  it("round-trips", () => {
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("does not expose raw offsets in the encoded string", () => {
    expect(encodeCursor(cursor)).not.toContain("offsetDate");
  });

  it("rejects a tampered cursor", () => {
    expect(() => decodeCursor(encodeCursor(cursor) + "x")).toThrowError(
      GramScopeError,
    );
  });

  it("rejects a non-base64 cursor", () => {
    expect(() => decodeCursor("!!!not a cursor!!!")).toThrowError(
      GramScopeError,
    );
  });

  it("rejects a future cursor version", () => {
    const forged = Buffer.from(JSON.stringify({ v: 99, d: 1, i: 2 })).toString(
      "base64url",
    );
    expect(() => decodeCursor(forged)).toThrowError(/INVALID_CURSOR|version/i);
  });

  it("rejects a structurally wrong payload", () => {
    const forged = Buffer.from(JSON.stringify({ v: 1, d: "x" })).toString(
      "base64url",
    );
    expect(() => decodeCursor(forged)).toThrowError(GramScopeError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/pagination.test.ts`
Expected: FAIL — cannot resolve `@/pagination`.

- [ ] **Step 3: Write the implementation**

`src/pagination.ts`:

```typescript
import { z } from "zod";
import { GramScopeError } from "./errors/taxonomy";

export const CURSOR_VERSION = 1;

/**
 * Telegram resumes getDialogs from offset_date + offset_id + offset_peer, but
 * offset_peer must be a real InputPeer TL object carrying an access hash, and
 * a stateless server has no entity cache to rebuild one from. We therefore
 * paginate on date + id only. The cost is that dialogs sharing an exact
 * last-message timestamp may tie at a page boundary; Task 11's live
 * disjoint-pages test is the guard on whether that ever bites in practice.
 */
export type DialogCursor = {
  offsetDate: number;
  offsetId: number;
};

const payloadSchema = z.object({
  v: z.literal(CURSOR_VERSION),
  d: z.number().int(),
  i: z.number().int(),
});

export function encodeCursor(cursor: DialogCursor): string {
  const payload = {
    v: CURSOR_VERSION,
    d: cursor.offsetDate,
    i: cursor.offsetId,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor(raw: string): DialogCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new GramScopeError("INVALID_CURSOR", "Cursor is not decodable");
  }

  const result = payloadSchema.safeParse(parsed);
  if (!result.success) {
    throw new GramScopeError(
      "INVALID_CURSOR",
      "Cursor is malformed or from an unsupported version",
    );
  }

  return {
    offsetDate: result.data.d,
    offsetId: result.data.i,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/pagination.test.ts`
Expected: PASS (6 tests).

Note: `Buffer.from(str, "base64url")` is lenient and will not throw on every malformed input — the schema check is what makes the tampered and wrong-shape cases fail. Both paths must return `INVALID_CURSOR`, never a decoded-but-wrong cursor.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add opaque versioned cursors"
```

---

### Task 4: Entity schemas and the response size cap

**Files:**
- Create: `src/schemas/source.ts`
- Create: `src/schemas/folder.ts`
- Create: `src/schemas/size.ts`
- Test: `tests/schemas.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `telegramSourceSchema` / `type TelegramSource` from `src/schemas/source.ts`.
  - `telegramFolderSchema` / `type TelegramFolder` from `src/schemas/folder.ts`.
  - `MAX_RESPONSE_BYTES` and `fitToSizeCap<T>(items: T[], build: (kept: T[]) => unknown): number` from `src/schemas/size.ts`, returning how many leading items fit under the cap (at least 1 when any item exists).

- [ ] **Step 1: Write the failing test**

`tests/schemas.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { telegramSourceSchema } from "@/schemas/source";
import { telegramFolderSchema } from "@/schemas/folder";
import { fitToSizeCap, MAX_RESPONSE_BYTES } from "@/schemas/size";

describe("telegramSourceSchema", () => {
  it("accepts a minimal source", () => {
    const parsed = telegramSourceSchema.parse({
      id: "-1001234567890",
      title: "Example",
      type: "channel",
    });
    expect(parsed.username).toBeUndefined();
  });

  it("rejects an unknown type", () => {
    expect(() =>
      telegramSourceSchema.parse({ id: "1", title: "x", type: "bot" }),
    ).toThrow();
  });

  it("keeps unread bookkeeping fields", () => {
    const parsed = telegramSourceSchema.parse({
      id: "1",
      title: "x",
      type: "channel",
      unread_count: 7,
      read_inbox_max_id: 99,
      folder_ids: ["2"],
    });
    expect(parsed.unread_count).toBe(7);
    expect(parsed.read_inbox_max_id).toBe(99);
    expect(parsed.folder_ids).toEqual(["2"]);
  });
});

describe("telegramFolderSchema", () => {
  it("accepts a folder with both peer lists", () => {
    const parsed = telegramFolderSchema.parse({
      id: "2",
      title: "AI",
      included_peer_ids: ["1", "2"],
      excluded_peer_ids: [],
      order: 0,
    });
    expect(parsed.title).toBe("AI");
  });
});

describe("fitToSizeCap", () => {
  const build = (kept: string[]) => ({ sources: kept });

  it("keeps everything when small", () => {
    expect(fitToSizeCap(["a", "b", "c"], build)).toBe(3);
  });

  it("drops items that would exceed the cap", () => {
    const big = "x".repeat(50_000);
    const items = Array.from({ length: 20 }, () => big);
    const kept = fitToSizeCap(items, build);
    expect(kept).toBeLessThan(20);
    expect(
      Buffer.byteLength(JSON.stringify(build(items.slice(0, kept))), "utf8"),
    ).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
  });

  it("keeps at least one item even if it alone exceeds the cap", () => {
    const huge = "x".repeat(MAX_RESPONSE_BYTES * 2);
    expect(fitToSizeCap([huge], build)).toBe(1);
  });

  it("returns zero for an empty list", () => {
    expect(fitToSizeCap([], build)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/schemas.test.ts`
Expected: FAIL — cannot resolve `@/schemas/source`.

- [ ] **Step 3: Write the schemas**

`src/schemas/source.ts`:

```typescript
import { z } from "zod";

export const telegramSourceSchema = z.object({
  id: z.string(),
  title: z.string(),
  username: z.string().optional(),
  description: z.string().optional(),
  url: z.string().optional(),
  type: z.enum(["channel", "group", "chat"]),
  subscriber_count: z.number().int().optional(),
  folder_ids: z.array(z.string()).optional(),
  unread_count: z.number().int().optional(),
  read_inbox_max_id: z.number().int().optional(),
  linked_discussion_id: z.string().optional(),
});

export type TelegramSource = z.infer<typeof telegramSourceSchema>;
```

`src/schemas/folder.ts`:

```typescript
import { z } from "zod";

export const telegramFolderSchema = z.object({
  id: z.string(),
  title: z.string(),
  included_peer_ids: z.array(z.string()),
  excluded_peer_ids: z.array(z.string()),
  order: z.number().int(),
});

export type TelegramFolder = z.infer<typeof telegramFolderSchema>;
```

`src/schemas/size.ts`:

```typescript
export const MAX_RESPONSE_BYTES = 256 * 1024;

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

/**
 * Returns how many leading items fit under the response cap. Always keeps at
 * least one item when the list is non-empty: an oversized single item is the
 * caller's problem to report, not a reason to return an empty page forever.
 */
export function fitToSizeCap<T>(
  items: T[],
  build: (kept: T[]) => unknown,
): number {
  if (items.length === 0) return 0;
  if (byteLength(build(items)) <= MAX_RESPONSE_BYTES) return items.length;

  let low = 1;
  let high = items.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (byteLength(build(items.slice(0, mid))) <= MAX_RESPONSE_BYTES) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/schemas.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add source and folder schemas with response size cap"
```

---

### Task 5: `withTelegram` connection lifecycle

**Files:**
- Create: `src/telegram/client.ts`
- Test: `tests/telegram-client.test.ts`

**Interfaces:**
- Consumes: `loadConfig` from `src/config.ts`; `mapTelegramError` from `src/errors/from-telegram.ts`.
- Produces: from `src/telegram/client.ts`:
  - `type TelegramLike = { connected?: boolean; connect(): Promise<boolean>; invoke(request: unknown): Promise<unknown>; getDialogs(params: Record<string, unknown>): Promise<unknown[]>; getEntity(entity: string): Promise<Record<string, unknown>> }`
  - `withTelegram<T>(fn: (client: TelegramLike) => Promise<T>): Promise<T>`
  - `getApi(): Promise<ApiNamespace>` — the TL request namespace; the only sanctioned way to reach `Api` outside this module
  - `__setClientFactoryForTests(factory: (() => Promise<TelegramLike>) | undefined): void`
  - `__resetClientForTests(): void`

- [ ] **Step 1: Write the failing test**

`tests/telegram-client.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  withTelegram,
  __setClientFactoryForTests,
  __resetClientForTests,
  type TelegramLike,
} from "@/telegram/client";
import { GramScopeError } from "@/errors/taxonomy";

function fakeClient(overrides: Partial<TelegramLike> = {}) {
  return {
    connected: false,
    connect: vi.fn(async function (this: TelegramLike) {
      this.connected = true;
      return true;
    }),
    invoke: vi.fn(async () => ({ ok: true })),
    getDialogs: vi.fn(async () => []),
    getEntity: vi.fn(async () => ({})),
    ...overrides,
  } as TelegramLike & { connect: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  __resetClientForTests();
  __setClientFactoryForTests(undefined);
});

describe("withTelegram", () => {
  it("connects on a cold instance", async () => {
    const client = fakeClient();
    __setClientFactoryForTests(async () => client);
    await withTelegram(async (c) => c.invoke({}));
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it("reuses a warm client without reconnecting", async () => {
    const client = fakeClient();
    __setClientFactoryForTests(async () => client);
    await withTelegram(async (c) => c.invoke({}));
    await withTelegram(async (c) => c.invoke({}));
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it("builds the client only once across calls", async () => {
    const factory = vi.fn(async () => fakeClient());
    __setClientFactoryForTests(factory);
    await withTelegram(async () => undefined);
    await withTelegram(async () => undefined);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("translates Telegram failures into the taxonomy", async () => {
    const client = fakeClient({
      invoke: vi.fn(async () => {
        throw Object.assign(new Error("FLOOD_WAIT_7"), {
          errorMessage: "FLOOD_WAIT_7",
        });
      }),
    });
    __setClientFactoryForTests(async () => client);

    const error = await withTelegram(async (c) => c.invoke({})).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(GramScopeError);
    expect((error as GramScopeError).code).toBe("RATE_LIMITED");
    expect((error as GramScopeError).retryAfterSeconds).toBe(7);
  });

  it("drops a cached client whose connection failed, so the next call rebuilds", async () => {
    const failing = fakeClient({
      connect: vi.fn(async () => {
        throw Object.assign(new Error("AUTH_KEY_UNREGISTERED"), {
          errorMessage: "AUTH_KEY_UNREGISTERED",
        });
      }),
    });
    const healthy = fakeClient();
    const factory = vi
      .fn<() => Promise<TelegramLike>>()
      .mockResolvedValueOnce(failing)
      .mockResolvedValueOnce(healthy);
    __setClientFactoryForTests(factory);

    await expect(withTelegram(async () => undefined)).rejects.toBeInstanceOf(
      GramScopeError,
    );
    await withTelegram(async () => undefined);
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/telegram-client.test.ts`
Expected: FAIL — cannot resolve `@/telegram/client`.

- [ ] **Step 3: Write the implementation**

`src/telegram/client.ts`:

```typescript
import { loadConfig } from "../config";
import { mapTelegramError } from "../errors/from-telegram";

export type TelegramLike = {
  connected?: boolean;
  connect(): Promise<boolean>;
  invoke(request: unknown): Promise<unknown>;
  getDialogs(params: Record<string, unknown>): Promise<unknown[]>;
  getEntity(entity: string): Promise<Record<string, unknown>>;
};

type Factory = () => Promise<TelegramLike>;

type ApiNamespace = (typeof import("teleproto"))["Api"];

let apiNamespace: ApiNamespace | undefined;

/**
 * The TL request namespace. This module is the ONLY one permitted to import
 * teleproto; every other module reaches MTProto through withTelegram and this
 * accessor, so the client can be swapped or faked in one place.
 */
export async function getApi(): Promise<ApiNamespace> {
  apiNamespace ??= (await import("teleproto")).Api;
  return apiNamespace;
}

// Module scope: on a warm Vercel instance this survives between invocations,
// which is the point — a fresh MTProto handshake per tool call is wasteful and
// invites FLOOD_WAIT.
let cached: TelegramLike | undefined;
let testFactory: Factory | undefined;

const defaultFactory: Factory = async () => {
  const config = loadConfig();
  const { TelegramClient } = await import("teleproto");
  const { StringSession } = await import("teleproto/sessions");
  return new TelegramClient(
    new StringSession(config.telegramSession),
    config.telegramApiId,
    config.telegramApiHash,
    { connectionRetries: 3 },
  ) as unknown as TelegramLike;
};

export function __setClientFactoryForTests(factory: Factory | undefined): void {
  testFactory = factory;
}

export function __resetClientForTests(): void {
  cached = undefined;
}

/**
 * The only path to MTProto. No tool may import a Telegram client directly.
 */
export async function withTelegram<T>(
  fn: (client: TelegramLike) => Promise<T>,
): Promise<T> {
  const factory = testFactory ?? defaultFactory;

  let client = cached;
  if (!client) {
    client = await factory();
    cached = client;
  }

  try {
    if (!client.connected) await client.connect();
  } catch (err) {
    // A client that cannot connect must not be reused.
    cached = undefined;
    throw mapTelegramError(err);
  }

  try {
    return await fn(client);
  } catch (err) {
    throw mapTelegramError(err);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/telegram-client.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add withTelegram connection lifecycle with reuse and error mapping"
```

---

### Task 6: Dialog filters — `list_folders` data layer

**Files:**
- Create: `src/telegram/peer-id.ts`
- Create: `src/telegram/folders.ts`
- Test: `tests/telegram-folders.test.ts`

**Interfaces:**
- Consumes: `withTelegram` from `src/telegram/client.ts`; `TelegramFolder` from `src/schemas/folder.ts`.
- Produces:
  - `readBigId(value: unknown): string | undefined` from `src/telegram/peer-id.ts` — unwraps teleproto's BigInteger wrappers to a decimal string. Task 7 imports the same helper rather than redefining it.
- Produces: from `src/telegram/folders.ts`:
  - `peerId(peer: unknown): string | undefined` — normalizes an `InputPeer` to a decimal id string.
  - `mapDialogFilters(raw: unknown): TelegramFolder[]`
  - `fetchFolders(): Promise<TelegramFolder[]>`

Read the terminology trap in Global Constraints before starting: these are dialog *filters*, not the archive.

- [ ] **Step 1: Write the failing test**

`tests/telegram-folders.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { mapDialogFilters, peerId } from "@/telegram/folders";

// Shapes mirror teleproto 1.229.0: messages.DialogFilters wraps `.filters`,
// `title` is TextWithEntities, and DialogFilterDefault carries no id/title.
const raw = {
  className: "messages.DialogFilters",
  filters: [
    { className: "DialogFilterDefault" },
    {
      className: "DialogFilter",
      id: 2,
      title: { className: "TextWithEntities", text: "AI", entities: [] },
      includePeers: [
        { className: "InputPeerChannel", channelId: { value: 111n } },
        { className: "InputPeerChat", chatId: { value: 222n } },
      ],
      excludePeers: [
        { className: "InputPeerUser", userId: { value: 333n } },
      ],
    },
    {
      className: "DialogFilterChatlist",
      id: 3,
      title: { className: "TextWithEntities", text: "Shared", entities: [] },
      includePeers: [
        { className: "InputPeerChannel", channelId: { value: 444n } },
      ],
    },
  ],
};

describe("peerId", () => {
  it("reads a channel peer", () => {
    expect(
      peerId({ className: "InputPeerChannel", channelId: { value: 111n } }),
    ).toBe("111");
  });

  it("returns undefined for an empty peer", () => {
    expect(peerId({ className: "InputPeerEmpty" })).toBeUndefined();
  });
});

describe("mapDialogFilters", () => {
  it("skips DialogFilterDefault, which has no id or title", () => {
    const folders = mapDialogFilters(raw);
    expect(folders.map((f) => f.id)).toEqual(["2", "3"]);
  });

  it("reads the title out of TextWithEntities", () => {
    expect(mapDialogFilters(raw)[0]!.title).toBe("AI");
  });

  it("maps both peer lists for a DialogFilter", () => {
    const ai = mapDialogFilters(raw)[0]!;
    expect(ai.included_peer_ids).toEqual(["111", "222"]);
    expect(ai.excluded_peer_ids).toEqual(["333"]);
  });

  it("gives a chatlist folder an empty exclude list, since it has no excludePeers", () => {
    const shared = mapDialogFilters(raw)[1]!;
    expect(shared.included_peer_ids).toEqual(["444"]);
    expect(shared.excluded_peer_ids).toEqual([]);
  });

  it("assigns order by position", () => {
    expect(mapDialogFilters(raw).map((f) => f.order)).toEqual([0, 1]);
  });

  it("returns an empty list when the wrapper has no filters", () => {
    expect(mapDialogFilters({ filters: [] })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/telegram-folders.test.ts`
Expected: FAIL — cannot resolve `@/telegram/folders`.

- [ ] **Step 3: Write the shared id helper**

`src/telegram/peer-id.ts`:

```typescript
/**
 * Unwraps the shapes teleproto uses for Telegram ids — bigint, number, string,
 * or a BigInteger-like `{ value }` wrapper — into a decimal string. Shared so
 * folders and dialogs cannot drift apart on id handling.
 */
export function readBigId(value: unknown): string | undefined {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "value" in value) {
    return readBigId((value as { value: unknown }).value);
  }
  return undefined;
}
```

- [ ] **Step 4: Write the implementation**

`src/telegram/folders.ts`:

```typescript
import { getApi, withTelegram } from "./client";
import { readBigId } from "./peer-id";
import type { TelegramFolder } from "../schemas/folder";

/** Normalizes any InputPeer variant to a decimal id string. */
export function peerId(peer: unknown): string | undefined {
  if (typeof peer !== "object" || peer === null) return undefined;
  const p = peer as Record<string, unknown>;
  return (
    readBigId(p.channelId) ?? readBigId(p.chatId) ?? readBigId(p.userId)
  );
}

function titleText(title: unknown): string {
  if (typeof title === "string") return title;
  if (typeof title === "object" && title !== null && "text" in title) {
    const text = (title as { text: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
}

export function mapDialogFilters(raw: unknown): TelegramFolder[] {
  const filters =
    typeof raw === "object" && raw !== null && "filters" in raw
      ? (raw as { filters: unknown }).filters
      : undefined;
  if (!Array.isArray(filters)) return [];

  const folders: TelegramFolder[] = [];
  for (const filter of filters) {
    if (typeof filter !== "object" || filter === null) continue;
    const f = filter as Record<string, unknown>;

    // DialogFilterDefault is the "All chats" pseudo-entry: no id, no title.
    if (f.id === undefined || f.title === undefined) continue;

    const include = Array.isArray(f.includePeers) ? f.includePeers : [];
    const exclude = Array.isArray(f.excludePeers) ? f.excludePeers : [];

    folders.push({
      id: String(f.id),
      title: titleText(f.title),
      included_peer_ids: include
        .map(peerId)
        .filter((id): id is string => id !== undefined),
      excluded_peer_ids: exclude
        .map(peerId)
        .filter((id): id is string => id !== undefined),
      order: folders.length,
    });
  }
  return folders;
}

export async function fetchFolders(): Promise<TelegramFolder[]> {
  return withTelegram(async (client) => {
    const Api = await getApi();
    const raw = await client.invoke(new Api.messages.GetDialogFilters());
    return mapDialogFilters(raw);
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- tests/telegram-folders.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add src/telegram/peer-id.ts src/telegram/folders.ts tests/telegram-folders.test.ts
git commit -m "feat: map Telegram dialog filters to folders"
```

---

### Task 7: Dialogs and channel detail data layer

**Files:**
- Create: `src/telegram/dialogs.ts`
- Test: `tests/telegram-dialogs.test.ts`

**Interfaces:**
- Consumes: `withTelegram`, `fetchFolders`, `peerId`, `TelegramSource`, `DialogCursor`, `encodeCursor`, `GramScopeError`.
- Produces: from `src/telegram/dialogs.ts`:
  - `dialogType(dialog: unknown): "channel" | "group" | "chat"`
  - `mapDialog(dialog: unknown, folderIdsByPeer: Map<string, string[]>): TelegramSource`
  - `foldersByPeer(folders: TelegramFolder[]): Map<string, string[]>`
  - `listDialogs(input: ListDialogsInput): Promise<{ sources: TelegramSource[]; next_cursor?: string }>`
  - `getChannel(input: { id?: string; username?: string; url?: string }): Promise<TelegramSource>`
  - `type ListDialogsInput = { folder_id?: string; unread_only?: boolean; type?: "channel" | "group" | "chat"; limit: number; cursor?: string }`

**Folder-criteria decision (spec §10, resolved here):** `list_dialogs(folder_id)` honors `included_peer_ids` minus `excluded_peer_ids` only. It deliberately ignores `excludeMuted`, `excludeRead`, and the contacts/groups/broadcasts type flags, because those depend on live mute and read state and would make the tool's output non-reproducible. The tool description must state this so ChatGPT does not present it as identical to the Telegram app's tab.

- [ ] **Step 1: Write the failing test**

`tests/telegram-dialogs.test.ts`:

```typescript
import { afterEach, describe, expect, it } from "vitest";
import {
  dialogType,
  foldersByPeer,
  getChannel,
  listDialogs,
  mapDialog,
} from "@/telegram/dialogs";
import {
  __resetClientForTests,
  __setClientFactoryForTests,
} from "@/telegram/client";
import { decodeCursor, encodeCursor } from "@/pagination";
import { GramScopeError } from "@/errors/taxonomy";

const channelDialog = {
  id: { value: 111n },
  title: "AI News",
  unreadCount: 5,
  isChannel: true,
  isGroup: false,
  isUser: false,
  entity: { className: "Channel", username: "ainews", participantsCount: 4200 },
  dialog: { readInboxMaxId: 900 },
};

describe("dialogType", () => {
  it("classifies a broadcast channel", () => {
    expect(dialogType(channelDialog)).toBe("channel");
  });

  it("classifies a group", () => {
    expect(
      dialogType({ ...channelDialog, isChannel: false, isGroup: true }),
    ).toBe("group");
  });

  it("classifies a private chat", () => {
    expect(
      dialogType({
        ...channelDialog,
        isChannel: false,
        isGroup: false,
        isUser: true,
      }),
    ).toBe("chat");
  });
});

describe("foldersByPeer", () => {
  it("inverts folder membership, honoring exclusions", () => {
    const index = foldersByPeer([
      {
        id: "2",
        title: "AI",
        included_peer_ids: ["111", "222"],
        excluded_peer_ids: ["222"],
        order: 0,
      },
      {
        id: "3",
        title: "Tech",
        included_peer_ids: ["111"],
        excluded_peer_ids: [],
        order: 1,
      },
    ]);
    expect(index.get("111")).toEqual(["2", "3"]);
    expect(index.get("222")).toBeUndefined();
  });
});

describe("mapDialog", () => {
  it("maps a channel to a source", () => {
    const source = mapDialog(channelDialog, new Map([["111", ["2"]]]));
    expect(source).toMatchObject({
      id: "111",
      title: "AI News",
      username: "ainews",
      type: "channel",
      unread_count: 5,
      subscriber_count: 4200,
      read_inbox_max_id: 900,
      folder_ids: ["2"],
    });
  });

  it("builds a t.me url from the username", () => {
    expect(mapDialog(channelDialog, new Map()).url).toBe("https://t.me/ainews");
  });

  it("omits url and username for a private channel", () => {
    const source = mapDialog(
      { ...channelDialog, entity: { className: "Channel" } },
      new Map(),
    );
    expect(source.username).toBeUndefined();
    expect(source.url).toBeUndefined();
  });

  it("omits folder_ids when the peer is in no folder", () => {
    expect(mapDialog(channelDialog, new Map()).folder_ids).toBeUndefined();
  });
});

describe("listDialogs cursor advance", () => {
  function dialogAt(id: number, date: number, unread: number) {
    return {
      id: { value: BigInt(id) },
      title: `Chat ${id}`,
      unreadCount: unread,
      isChannel: true,
      isGroup: false,
      isUser: false,
      date,
      message: { id: date },
      entity: { className: "Channel" },
      dialog: { readInboxMaxId: 0 },
    };
  }

  function install(dialogs: unknown[]) {
    __setClientFactoryForTests(async () => ({
      connected: true,
      connect: async () => true,
      invoke: async () => ({ filters: [] }),
      getDialogs: async () => dialogs,
      getEntity: async () => ({}),
    }));
  }

  afterEach(() => {
    __resetClientForTests();
    __setClientFactoryForTests(undefined);
  });

  it("still returns a cursor when every row is filtered out", async () => {
    // All read, so unread_only removes everything. Without a cursor the caller
    // can never reach the unread dialogs further down the list.
    install([dialogAt(1, 100, 0), dialogAt(2, 90, 0), dialogAt(3, 80, 0)]);
    const page = await listDialogs({ limit: 2, unread_only: true });
    expect(page.sources).toEqual([]);
    expect(page.next_cursor).toBeTruthy();
  });

  it("derives the cursor from the raw batch, not the filtered length", async () => {
    // Row 1 is filtered out, so a cursor built from the filtered page length
    // would point at row 1 and re-serve row 2 forever.
    install([dialogAt(1, 100, 0), dialogAt(2, 90, 5), dialogAt(3, 80, 5)]);
    const first = await listDialogs({ limit: 2, unread_only: true });
    expect(first.sources.map((s) => s.id)).toEqual(["2", "3"]);
    expect(decodeCursor(first.next_cursor!).offsetDate).toBe(80);
  });

  it("omits the cursor when the batch is exhausted and nothing was trimmed", async () => {
    install([dialogAt(1, 100, 5)]);
    const page = await listDialogs({ limit: 50 });
    expect(page.next_cursor).toBeUndefined();
  });

  it("forwards the cursor offsets to getDialogs", async () => {
    // The cursor must actually reach the query; a cursor that round-trips but
    // is never sent silently re-serves page one forever.
    const calls: Record<string, unknown>[] = [];
    __setClientFactoryForTests(async () => ({
      connected: true,
      connect: async () => true,
      invoke: async () => ({ filters: [] }),
      getDialogs: async (params: Record<string, unknown>) => {
        calls.push(params);
        return [];
      },
      getEntity: async () => ({}),
    }));
    await listDialogs({
      limit: 10,
      cursor: encodeCursor({ offsetDate: 100, offsetId: 5 }),
    });
    expect(calls[0]).toMatchObject({ offsetDate: 100, offsetId: 5 });
  });
});

describe("getChannel", () => {
  function installEntity(entity: Record<string, unknown>) {
    __setClientFactoryForTests(async () => ({
      connected: true,
      connect: async () => true,
      invoke: async () => ({ filters: [] }),
      getDialogs: async () => [],
      getEntity: async () => entity,
    }));
  }

  afterEach(() => {
    __resetClientForTests();
    __setClientFactoryForTests(undefined);
  });

  it("rejects when no identifier is given", async () => {
    installEntity({});
    await expect(getChannel({})).rejects.toBeInstanceOf(GramScopeError);
  });

  it("rejects when more than one identifier is given", async () => {
    installEntity({});
    await expect(
      getChannel({ id: "1", username: "two" }),
    ).rejects.toBeInstanceOf(GramScopeError);
  });

  it("rejects a URL that is not a Telegram link", async () => {
    installEntity({});
    await expect(
      getChannel({ url: "https://example.com/nope" }),
    ).rejects.toBeInstanceOf(GramScopeError);
  });

  it("accepts both the plain and the /s/ t.me URL forms", async () => {
    installEntity({
      className: "Channel",
      id: { value: 111n },
      title: "AI News",
      username: "ainews",
    });
    expect((await getChannel({ url: "https://t.me/ainews" })).id).toBe("111");
    expect((await getChannel({ url: "https://t.me/s/ainews" })).id).toBe("111");
  });

  it("classifies a megagroup as a group, not a channel", async () => {
    installEntity({
      className: "Channel",
      id: { value: 222n },
      title: "Chat",
      megagroup: true,
    });
    expect((await getChannel({ id: "222" })).type).toBe("group");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/telegram-dialogs.test.ts`
Expected: FAIL — cannot resolve `@/telegram/dialogs`.

- [ ] **Step 3: Write the implementation**

`src/telegram/dialogs.ts`:

```typescript
import { withTelegram } from "./client";
import { fetchFolders } from "./folders";
import { readBigId } from "./peer-id";
import type { TelegramFolder } from "../schemas/folder";
import type { TelegramSource } from "../schemas/source";
import { decodeCursor, encodeCursor } from "../pagination";
import { GramScopeError } from "../errors/taxonomy";
import { fitToSizeCap } from "../schemas/size";

export type ListDialogsInput = {
  folder_id?: string;
  unread_only?: boolean;
  type?: "channel" | "group" | "chat";
  limit: number;
  cursor?: string;
};

export function dialogType(dialog: unknown): "channel" | "group" | "chat" {
  const d = dialog as Record<string, unknown>;
  if (d.isChannel === true && d.isGroup !== true) return "channel";
  if (d.isGroup === true) return "group";
  return "chat";
}

export function foldersByPeer(
  folders: TelegramFolder[],
): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const folder of folders) {
    const excluded = new Set(folder.excluded_peer_ids);
    for (const id of folder.included_peer_ids) {
      if (excluded.has(id)) continue;
      const existing = index.get(id);
      if (existing) existing.push(folder.id);
      else index.set(id, [folder.id]);
    }
  }
  return index;
}

export function mapDialog(
  dialog: unknown,
  folderIdsByPeer: Map<string, string[]>,
): TelegramSource {
  const d = dialog as Record<string, unknown>;
  const entity = (d.entity ?? {}) as Record<string, unknown>;
  const inner = (d.dialog ?? {}) as Record<string, unknown>;

  const id = readBigId(d.id) ?? "";
  const username =
    typeof entity.username === "string" ? entity.username : undefined;
  const folderIds = folderIdsByPeer.get(id);

  return {
    id,
    title: typeof d.title === "string" ? d.title : "",
    type: dialogType(dialog),
    ...(username ? { username, url: `https://t.me/${username}` } : {}),
    ...(typeof entity.about === "string" ? { description: entity.about } : {}),
    ...(typeof entity.participantsCount === "number"
      ? { subscriber_count: entity.participantsCount }
      : {}),
    ...(typeof d.unreadCount === "number"
      ? { unread_count: d.unreadCount }
      : {}),
    ...(typeof inner.readInboxMaxId === "number"
      ? { read_inbox_max_id: inner.readInboxMaxId }
      : {}),
    ...(folderIds ? { folder_ids: folderIds } : {}),
  };
}

export async function listDialogs(
  input: ListDialogsInput,
): Promise<{ sources: TelegramSource[]; next_cursor?: string }> {
  const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
  const folders = await fetchFolders();
  const folderIndex = foldersByPeer(folders);

  let allowed: Set<string> | undefined;
  if (input.folder_id) {
    const folder = folders.find((f) => f.id === input.folder_id);
    if (!folder) {
      throw new GramScopeError(
        "INVALID_INPUT",
        `No folder with id ${input.folder_id}. Call list_folders for valid ids.`,
      );
    }
    const excluded = new Set(folder.excluded_peer_ids);
    allowed = new Set(
      folder.included_peer_ids.filter((id) => !excluded.has(id)),
    );
  }

  const batchSize = input.limit + 1;
  const raw = await withTelegram(async (client) =>
    client.getDialogs({
      limit: batchSize,
      // Only date and id: teleproto forwards offsetPeer straight into
      // Api.messages.GetDialogs without resolving it, so it must be a real
      // InputPeer object, which a stateless server cannot rebuild. See the
      // note on DialogCursor.
      ...(cursor
        ? { offsetDate: cursor.offsetDate, offsetId: cursor.offsetId }
        : {}),
    }),
  );

  // Filters below are client-side, so a row must keep its link to the raw
  // dialog it came from: the cursor is derived from how far we consumed the
  // RAW batch, never from the filtered page's length.
  type Row = { raw: Record<string, unknown>; source: TelegramSource };
  const rows: Row[] = raw.map((dialog) => ({
    raw: (dialog ?? {}) as Record<string, unknown>,
    source: mapDialog(dialog, folderIndex),
  }));

  let kept = rows;
  if (allowed) kept = kept.filter((r) => allowed.has(r.source.id));
  if (input.unread_only) {
    kept = kept.filter((r) => (r.source.unread_count ?? 0) > 0);
  }
  if (input.type) kept = kept.filter((r) => r.source.type === input.type);

  const limited = kept.slice(0, input.limit);
  const fit = fitToSizeCap(
    limited.map((r) => r.source),
    (items) => ({ sources: items }),
  );
  const page = limited.slice(0, fit);
  const sources = page.map((r) => r.source);

  // Truncated inside the batch: resume after the last row we actually
  // returned. Otherwise we consumed the whole batch: resume after its end.
  const truncated = page.length < kept.length;
  const lastExamined = truncated ? page[page.length - 1] : rows[rows.length - 1];
  const hasMore = truncated || raw.length >= batchSize;

  if (!hasMore || !lastExamined) return { sources };

  const last = lastExamined.raw;
  const message = last.message as Record<string, unknown> | undefined;
  return {
    sources,
    next_cursor: encodeCursor({
      offsetDate: typeof last.date === "number" ? last.date : 0,
      offsetId: typeof message?.id === "number" ? message.id : 0,
    }),
  };
}

export async function getChannel(input: {
  id?: string;
  username?: string;
  url?: string;
}): Promise<TelegramSource> {
  const identifiers = [input.id, input.username, input.url].filter(Boolean);
  if (identifiers.length !== 1) {
    throw new GramScopeError(
      "INVALID_INPUT",
      "Provide exactly one of id, username, or url",
    );
  }

  let target = input.id ?? input.username ?? "";
  if (input.url) {
    const match = /t\.me\/(?:s\/)?([A-Za-z0-9_]+)/.exec(input.url);
    if (!match) {
      throw new GramScopeError("INVALID_INPUT", "Unrecognized Telegram URL");
    }
    target = match[1]!;
  }

  const folders = await fetchFolders();
  const index = foldersByPeer(folders);

  return withTelegram(async (client) => {
    const entity = await client.getEntity(target);
    const id = readBigId(entity.id) ?? "";
    const username =
      typeof entity.username === "string" ? entity.username : undefined;
    const folderIds = index.get(id);

    return {
      id,
      title:
        typeof entity.title === "string"
          ? entity.title
          : typeof entity.firstName === "string"
            ? entity.firstName
            : "",
      type:
        entity.className === "Channel" && entity.megagroup !== true
          ? "channel"
          : entity.className === "Channel" || entity.className === "Chat"
            ? "group"
            : "chat",
      ...(username ? { username, url: `https://t.me/${username}` } : {}),
      ...(typeof entity.participantsCount === "number"
        ? { subscriber_count: entity.participantsCount }
        : {}),
      ...(folderIds ? { folder_ids: folderIds } : {}),
    };
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/telegram-dialogs.test.ts`
Expected: PASS (17 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add dialog listing and channel detail data layer"
```

---

### Task 8: Owner authorization

**Files:**
- Create: `src/mcp/auth.ts`
- Test: `tests/auth.test.ts`

**Interfaces:**
- Consumes: `loadConfig` from `src/config.ts`.
- Produces: from `src/mcp/auth.ts`:
  - `type VerifiedOwner = { token: string; clientId: string; scopes: string[]; extra: { sub: string } }`
  - `verifyOwnerToken(req: Request, bearerToken?: string): Promise<VerifiedOwner | undefined>`
  - `__setKeyResolverForTests(resolver: unknown | undefined): void` — injects a `jose` key resolver so tests need no network.

- [ ] **Step 1: Write the failing test**

`tests/auth.test.ts`:

```typescript
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import {
  verifyOwnerToken,
  __setKeyResolverForTests,
} from "@/mcp/auth";

const ISSUER = "https://auth.example.com";
const AUDIENCE = "https://gramscope.example.app";

let privateKey: CryptoKey;
let publicJwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  publicJwk = await exportJWK(pair.publicKey);
  publicJwk.alg = "RS256";
  publicJwk.kid = "test-key";
});

function env() {
  return {
    TELEGRAM_API_ID: "1",
    TELEGRAM_API_HASH: "h",
    TELEGRAM_SESSION: "s",
    WORKOS_ISSUER: ISSUER,
    WORKOS_JWKS_URL: `${ISSUER}/jwks`,
    OWNER_USER_ID: "user_owner",
    MCP_RESOURCE_URL: AUDIENCE,
  };
}

async function token(sub: string, overrides: Record<string, string> = {}) {
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(overrides.iss ?? ISSUER)
    .setAudience(overrides.aud ?? AUDIENCE)
    .setSubject(sub)
    .setExpirationTime("5m")
    .sign(privateKey);
}

beforeAll(() => {
  process.env = { ...process.env, ...env() };
});

afterEach(() => {
  __setKeyResolverForTests(undefined);
});

async function withLocalKeys() {
  const { createLocalJWKSet } = await import("jose");
  __setKeyResolverForTests(createLocalJWKSet({ keys: [publicJwk] }));
}

const request = new Request("https://gramscope.example.app/api/mcp");

describe("verifyOwnerToken", () => {
  it("returns undefined when no token is presented", async () => {
    await withLocalKeys();
    expect(await verifyOwnerToken(request, undefined)).toBeUndefined();
  });

  it("accepts the configured owner", async () => {
    await withLocalKeys();
    const info = await verifyOwnerToken(request, await token("user_owner"));
    expect(info?.extra.sub).toBe("user_owner");
  });

  it("rejects an authenticated non-owner with OWNER_FORBIDDEN", async () => {
    await withLocalKeys();
    await expect(
      verifyOwnerToken(request, await token("user_stranger")),
    ).rejects.toThrow(/OWNER_FORBIDDEN/);
  });

  it("rejects a token from the wrong issuer", async () => {
    await withLocalKeys();
    await expect(
      verifyOwnerToken(
        request,
        await token("user_owner", { iss: "https://evil.example.com" }),
      ),
    ).rejects.toBeTruthy();
  });

  it("rejects a token for the wrong audience", async () => {
    await withLocalKeys();
    await expect(
      verifyOwnerToken(
        request,
        await token("user_owner", { aud: "https://other.example.app" }),
      ),
    ).rejects.toBeTruthy();
  });

  it("rejects a garbage token", async () => {
    await withLocalKeys();
    await expect(verifyOwnerToken(request, "not.a.jwt")).rejects.toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/auth.test.ts`
Expected: FAIL — cannot resolve `@/mcp/auth`.

- [ ] **Step 3: Write the implementation**

`src/mcp/auth.ts`:

```typescript
import { createRemoteJWKSet, jwtVerify } from "jose";
import { loadConfig } from "../config";
import { GramScopeError } from "../errors/taxonomy";

export type VerifiedOwner = {
  token: string;
  clientId: string;
  scopes: string[];
  extra: { sub: string };
};

type KeyResolver = Parameters<typeof jwtVerify>[1];

let testResolver: KeyResolver | undefined;
let remoteResolver: KeyResolver | undefined;

export function __setKeyResolverForTests(
  resolver: KeyResolver | undefined,
): void {
  testResolver = resolver;
}

function resolver(jwksUrl: string): KeyResolver {
  if (testResolver) return testResolver;
  remoteResolver ??= createRemoteJWKSet(new URL(jwksUrl));
  return remoteResolver;
}

export async function verifyOwnerToken(
  _req: Request,
  bearerToken?: string,
): Promise<VerifiedOwner | undefined> {
  if (!bearerToken) return undefined;

  const config = loadConfig();
  const audience = process.env.MCP_RESOURCE_URL;

  const { payload } = await jwtVerify(
    bearerToken,
    resolver(config.workosJwksUrl),
    {
      issuer: config.workosIssuer,
      ...(audience ? { audience } : {}),
    },
  );

  const sub = payload.sub;
  if (typeof sub !== "string" || sub !== config.ownerUserId) {
    throw new GramScopeError(
      "OWNER_FORBIDDEN",
      "OWNER_FORBIDDEN: this MCP server serves a single configured owner",
    );
  }

  return {
    token: bearerToken,
    clientId: typeof payload.azp === "string" ? payload.azp : "unknown",
    scopes: [],
    extra: { sub },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/auth.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Add `MCP_RESOURCE_URL` to `.env.example`**

```bash
printf 'MCP_RESOURCE_URL=\n' >> .env.example
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: verify owner tokens against JWKS with single-owner allowlist"
```

---

### Task 9: Tool registration and routes

**Files:**
- Create: `src/mcp/tool-result.ts`
- Create: `src/mcp/logging.ts`
- Create: `src/mcp/tools/list-folders.ts`
- Create: `src/mcp/tools/list-dialogs.ts`
- Create: `src/mcp/tools/get-channel.ts`
- Create: `src/mcp/server.ts`
- Create: `app/api/mcp/route.ts`
- Create: `app/.well-known/oauth-protected-resource/route.ts`
- Test: `tests/tools.test.ts`
- Test: `tests/logging.test.ts`

**Interfaces:**
- Consumes: `listDialogs`, `getChannel`, `fetchFolders`, `verifyOwnerToken`, schemas, `GramScopeError`.
- Produces:
  - `okResult<T>(data: T)` and `errorResult(err: unknown)` from `src/mcp/tool-result.ts`.
  - `formatEvent(event: McpEventLike): string | undefined` and `logEvent(event: McpEventLike, sink?: (line: string) => void): void` from `src/mcp/logging.ts`, where `type McpEventLike = { type: string; method?: string; status?: string; duration?: number; result?: unknown; error?: unknown }`.
  - `registerTools(server: McpServer): void` from `src/mcp/server.ts`.
  - Each `src/mcp/tools/*.ts` exports `register<Name>(server: McpServer): void`.

- [ ] **Step 1: Write the failing test**

`tests/tools.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { errorResult, okResult } from "@/mcp/tool-result";
import { GramScopeError } from "@/errors/taxonomy";
import { registerTools } from "@/mcp/server";

describe("tool results", () => {
  it("wraps data as structured content plus text", () => {
    const result = okResult({ sources: [] });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ sources: [] });
    expect(result.content[0]!.type).toBe("text");
  });

  it("renders a taxonomy error as structured content", () => {
    const result = errorResult(
      new GramScopeError("RATE_LIMITED", "slow down", 42),
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: "RATE_LIMITED",
      retry_after_seconds: 42,
    });
  });

  it("maps an unknown throw to INTERNAL_ERROR without leaking its message", () => {
    const result = errorResult(new Error("session=SECRETVALUE"));
    expect(result.structuredContent).toMatchObject({
      code: "INTERNAL_ERROR",
    });
    expect(JSON.stringify(result)).not.toContain("SECRETVALUE");
  });
});

describe("registerTools", () => {
  function fakeServer() {
    const tools: Array<{ name: string; config: Record<string, unknown> }> = [];
    return {
      tools,
      registerTool(name: string, config: Record<string, unknown>) {
        tools.push({ name, config });
      },
    };
  }

  it("registers exactly the three Foundation tools", () => {
    const server = fakeServer();
    registerTools(server as never);
    expect(server.tools.map((t) => t.name).sort()).toEqual([
      "get_channel",
      "list_dialogs",
      "list_folders",
    ]);
  });

  it("marks every tool read-only", () => {
    const server = fakeServer();
    registerTools(server as never);
    for (const tool of server.tools) {
      expect(tool.config.annotations).toMatchObject({ readOnlyHint: true });
    }
  });

  it("gives every tool a description and an output schema", () => {
    const server = fakeServer();
    registerTools(server as never);
    for (const tool of server.tools) {
      expect(tool.config.description).toBeTruthy();
      expect(tool.config.outputSchema).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/tools.test.ts`
Expected: FAIL — cannot resolve `@/mcp/tool-result`.

- [ ] **Step 3: Write the result helpers**

`src/mcp/tool-result.ts`:

```typescript
import { GramScopeError, type StructuredError } from "../errors/taxonomy";
import { mapTelegramError } from "../errors/from-telegram";
import { logToolCall } from "./logging";

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: unknown;
  isError?: true;
};

export function okResult<T>(data: T): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

export function errorResult(err: unknown): ToolResult {
  const mapped: GramScopeError =
    err instanceof GramScopeError ? err : mapTelegramError(err);
  const structured: StructuredError = mapped.toStructured();
  return {
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured,
    isError: true,
  };
}

function countOf(data: unknown): number | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  for (const key of ["sources", "folders"]) {
    const value = (data as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value.length;
  }
  return undefined;
}

/**
 * Runs one tool: times it, converts the outcome into a ToolResult, and records
 * a log line naming the tool. Every tool body goes through this, so no handler
 * can throw out into the transport and none is missing from the logs.
 */
export async function runTool<T>(
  name: string,
  run: () => Promise<T>,
  sink?: (line: string) => void,
): Promise<ToolResult> {
  const started = Date.now();
  try {
    const data = await run();
    logToolCall(
      {
        name,
        durationMs: Date.now() - started,
        status: "success",
        ...(countOf(data) !== undefined ? { count: countOf(data) } : {}),
      },
      sink,
    );
    return okResult(data);
  } catch (err) {
    const result = errorResult(err);
    logToolCall(
      {
        name,
        durationMs: Date.now() - started,
        status: "error",
        code: (result.structuredContent as StructuredError).code,
      },
      sink,
    );
    return result;
  }
}
```

- [ ] **Step 4: Write the three tools**

`src/mcp/tools/list-folders.ts`:

```typescript
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { fetchFolders } from "../../telegram/folders";
import { telegramFolderSchema } from "../../schemas/folder";
import { runTool } from "../tool-result";

export function registerListFolders(server: McpServer): void {
  server.registerTool(
    "list_folders",
    {
      title: "List Telegram folders",
      description:
        "List the Telegram chat folders (dialog filters) on the account, with the peers each includes and excludes. Use the returned id as folder_id for list_dialogs. Read-only.",
      inputSchema: z.object({}),
      outputSchema: z.object({ folders: z.array(telegramFolderSchema) }),
      annotations: { readOnlyHint: true },
    },
    async () => runTool("list_folders", async () => ({
      folders: await fetchFolders(),
    })),
  );
}
```

`src/mcp/tools/list-dialogs.ts`:

```typescript
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { listDialogs } from "../../telegram/dialogs";
import { telegramSourceSchema } from "../../schemas/source";
import { runTool } from "../tool-result";

export function registerListDialogs(server: McpServer): void {
  server.registerTool(
    "list_dialogs",
    {
      title: "List Telegram sources",
      description:
        "List channels, groups and chats on the account, with unread counts and folder membership. Filtering by folder_id honors the folder's included and excluded peers only; it ignores the folder's exclude-muted, exclude-read and chat-type flags, so results may differ from the folder tab in the Telegram app. Paginate with next_cursor. Read-only: this does not mark anything as read.",
      inputSchema: z.object({
        folder_id: z.string().optional(),
        unread_only: z.boolean().optional(),
        type: z.enum(["channel", "group", "chat"]).optional(),
        limit: z.number().int().min(1).max(200).default(50),
        cursor: z.string().optional(),
      }),
      outputSchema: z.object({
        sources: z.array(telegramSourceSchema),
        next_cursor: z.string().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (input) => runTool("list_dialogs", () => listDialogs(input)),
  );
}
```

`src/mcp/tools/get-channel.ts`:

```typescript
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { getChannel } from "../../telegram/dialogs";
import { telegramSourceSchema } from "../../schemas/source";
import { runTool } from "../tool-result";

export function registerGetChannel(server: McpServer): void {
  server.registerTool(
    "get_channel",
    {
      title: "Get a Telegram source",
      description:
        "Get details for one channel, group or chat by numeric id, @username, or t.me URL. Provide exactly one identifier. Read-only.",
      inputSchema: z.object({
        id: z.string().optional(),
        username: z.string().optional(),
        url: z.string().optional(),
      }),
      outputSchema: telegramSourceSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => runTool("get_channel", () => getChannel(input)),
  );
}
```

`src/mcp/server.ts`:

```typescript
import type { McpServer } from "@modelcontextprotocol/server";
import { registerGetChannel } from "./tools/get-channel";
import { registerListDialogs } from "./tools/list-dialogs";
import { registerListFolders } from "./tools/list-folders";

export function registerTools(server: McpServer): void {
  registerListDialogs(server);
  registerListFolders(server);
  registerGetChannel(server);
}
```

- [ ] **Step 5: Write the observability test**

Spec §6.6 requires tool name, duration, Telegram error class and result count in
logs, and forbids session strings, tokens and message bodies. `mcp-handler`
surfaces this through its `onEvent` callback.

`tests/logging.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { formatEvent, logEvent } from "@/mcp/logging";
import { runTool } from "@/mcp/tool-result";
import { GramScopeError } from "@/errors/taxonomy";

describe("formatEvent", () => {
  it("reports tool name, duration and result count on completion", () => {
    const line = formatEvent({
      type: "REQUEST_COMPLETED",
      method: "tools/call",
      status: "success",
      duration: 132,
      result: { structuredContent: { sources: [{ id: "1" }, { id: "2" }] } },
    });
    expect(line).toContain("tools/call");
    expect(line).toContain("132");
    expect(line).toContain("count=2");
  });

  it("reports the error code rather than the raw message", () => {
    const line = formatEvent({
      type: "REQUEST_COMPLETED",
      method: "tools/call",
      status: "error",
      duration: 5,
      result: {
        isError: true,
        structuredContent: { code: "RATE_LIMITED", message: "slow down" },
      },
    });
    expect(line).toContain("RATE_LIMITED");
  });

  it("never emits payload bodies", () => {
    const line = formatEvent({
      type: "REQUEST_COMPLETED",
      method: "tools/call",
      status: "success",
      duration: 1,
      result: {
        structuredContent: {
          sources: [{ id: "1", title: "Secret Channel Name" }],
        },
      },
    });
    expect(line).not.toContain("Secret Channel Name");
  });

  it("ignores events that carry no useful signal", () => {
    expect(formatEvent({ type: "REQUEST_RECEIVED", method: "tools/call" }))
      .toBeUndefined();
  });

  it("writes through the injected sink", () => {
    const sink = vi.fn();
    logEvent(
      { type: "REQUEST_COMPLETED", method: "tools/list", duration: 3 },
      sink,
    );
    expect(sink).toHaveBeenCalledOnce();
  });
});

describe("runTool logging", () => {
  it("names the tool and counts the results on success", async () => {
    const sink = vi.fn();
    const result = await runTool(
      "list_dialogs",
      async () => ({ sources: [{ id: "1" }, { id: "2" }] }),
      sink,
    );
    expect(result.isError).toBeUndefined();
    const line = sink.mock.calls[0]![0] as string;
    expect(line).toContain("tool=list_dialogs");
    expect(line).toContain("status=success");
    expect(line).toContain("count=2");
    expect(line).toMatch(/duration_ms=\d+/);
  });

  it("logs the error code and returns a structured error", async () => {
    const sink = vi.fn();
    const result = await runTool(
      "get_channel",
      async () => {
        throw new GramScopeError("CHANNEL_NOT_FOUND", "nope");
      },
      sink,
    );
    expect(result.isError).toBe(true);
    const line = sink.mock.calls[0]![0] as string;
    expect(line).toContain("tool=get_channel");
    expect(line).toContain("code=CHANNEL_NOT_FOUND");
  });

  it("never writes payload bodies into the log line", async () => {
    const sink = vi.fn();
    await runTool(
      "list_dialogs",
      async () => ({
        sources: [{ id: "1", title: "Secret Channel Name" }],
      }),
      sink,
    );
    expect(sink.mock.calls[0]![0]).not.toContain("Secret Channel Name");
  });

  it("contains a throw rather than letting it reach the transport", async () => {
    const sink = vi.fn();
    await expect(
      runTool("list_folders", async () => {
        throw new Error("boom");
      }, sink),
    ).resolves.toMatchObject({ isError: true });
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npm test -- tests/logging.test.ts`
Expected: FAIL — cannot resolve `@/mcp/logging`.

- [ ] **Step 7: Write the logger**

`src/mcp/logging.ts`:

```typescript
export type McpEventLike = {
  type: string;
  method?: string;
  status?: string;
  duration?: number;
  result?: unknown;
  error?: unknown;
};

function resultCount(result: unknown): number | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const structured = (result as { structuredContent?: unknown })
    .structuredContent;
  if (typeof structured !== "object" || structured === null) return undefined;
  for (const key of ["sources", "folders"]) {
    const value = (structured as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value.length;
  }
  return undefined;
}

function errorCode(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const structured = (result as { structuredContent?: unknown })
    .structuredContent;
  if (typeof structured !== "object" || structured === null) return undefined;
  const code = (structured as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Builds a log line from an mcp-handler event. Only names, codes, counts and
 * timings are emitted — never payload bodies, tokens, or session strings.
 */
export function formatEvent(event: McpEventLike): string | undefined {
  if (event.type === "ERROR") {
    return `mcp error source=system`;
  }
  if (event.type !== "REQUEST_COMPLETED") return undefined;

  const parts = [`mcp method=${event.method ?? "unknown"}`];
  if (event.status) parts.push(`status=${event.status}`);
  if (typeof event.duration === "number") parts.push(`duration_ms=${event.duration}`);

  const count = resultCount(event.result);
  if (count !== undefined) parts.push(`count=${count}`);

  const code = errorCode(event.result);
  if (code) parts.push(`code=${code}`);

  return parts.join(" ");
}

export function logEvent(
  event: McpEventLike,
  sink: (line: string) => void = console.log,
): void {
  const line = formatEvent(event);
  if (line) sink(line);
}

export type ToolCallLog = {
  name: string;
  durationMs: number;
  status: "success" | "error";
  count?: number;
  code?: string;
};

/**
 * Tool-level logging. mcp-handler's REQUEST_COMPLETED event carries only the
 * generic JSON-RPC method ("tools/call") and no result, so the tool name,
 * result count and error class are not derivable from it. They are recorded
 * here instead, where the call actually happens.
 */
export function formatToolCall(entry: ToolCallLog): string {
  const parts = [
    `mcp tool=${entry.name}`,
    `status=${entry.status}`,
    `duration_ms=${entry.durationMs}`,
  ];
  if (entry.count !== undefined) parts.push(`count=${entry.count}`);
  if (entry.code) parts.push(`code=${entry.code}`);
  return parts.join(" ");
}

export function logToolCall(
  entry: ToolCallLog,
  sink: (line: string) => void = console.log,
): void {
  sink(formatToolCall(entry));
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npm test -- tests/logging.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 9: Write the routes**

`app/api/mcp/route.ts`:

```typescript
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { registerTools } from "@/mcp/server";
import { verifyOwnerToken } from "@/mcp/auth";
import { logEvent } from "@/mcp/logging";

const handler = createMcpHandler(
  (server) => {
    registerTools(server);
  },
  {
    serverInfo: { name: "gramscope", version: "0.1.0" },
    onEvent: (event) => logEvent(event),
  },
);

const authed = withMcpAuth(handler, verifyOwnerToken, {
  required: true,
  resourceMetadataPath: "/.well-known/oauth-protected-resource",
});

export { authed as GET, authed as POST };
```

`app/.well-known/oauth-protected-resource/route.ts`:

```typescript
import {
  metadataCorsOptionsRequestHandler,
  protectedResourceHandler,
} from "mcp-handler";

// Read the issuer per request, not at module scope. Next imports every route
// module during "Collecting page data", so a top-level throw fails the whole
// build wherever env vars are injected at runtime rather than build time —
// fork preview builds, local builds, and secret-at-runtime pipelines. This
// also matches how loadConfig and verifyOwnerToken read their env.
export function GET(req: Request): Response {
  const issuer = process.env.WORKOS_ISSUER;
  if (!issuer) {
    return Response.json(
      { error: "server_misconfigured" },
      { status: 500 },
    );
  }
  return protectedResourceHandler({ authServerUrls: [issuer] })(req);
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `npm test -- tests/tools.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 11: Run the full gates**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat: register MCP tools, OAuth-protected routes, and event logging"
```

---

### Task 10: Session bootstrap script and provisioning wizard

**Files:**
- Create: `scripts/create-telegram-session.ts`
- Create: `scripts/provision.sh`
- Modify: `README.md` (append a "Setup" section)

**Interfaces:**
- Consumes: nothing from earlier tasks at runtime; reads `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` from the environment.
- Produces: a StringSession printed once to the operator's terminal, and `scripts/provision.sh` as the guided setup entry point.

This task has no automated test: both deliverables are interactive and drive external services. It is verified by running the wizard in Task 11.

- [ ] **Step 1: Write the session bootstrap script**

`scripts/create-telegram-session.ts`:

```typescript
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";

const rl = createInterface({ input: stdin, output: stdout });

async function main() {
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;
  if (!Number.isInteger(apiId) || !apiHash) {
    throw new Error(
      "Set TELEGRAM_API_ID and TELEGRAM_API_HASH before running this script",
    );
  }

  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 3,
  });

  await client.start({
    phoneNumber: () => rl.question("Phone number (with country code): "),
    phoneCode: () => rl.question("Login code from Telegram: "),
    password: () => rl.question("Two-factor password (blank if unset): "),
    onError: (err) => {
      console.error("Login failed:", err.message);
    },
  });

  console.log("\nLogin succeeded.\n");
  console.log(
    "Copy the session string below into TELEGRAM_SESSION. It grants FULL",
  );
  console.log("access to this Telegram account — treat it like a password.\n");
  console.log(client.session.save());
  console.log(
    "\nStore it now with:  vercel env add TELEGRAM_SESSION production\n",
  );

  await client.disconnect();
  rl.close();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
```

- [ ] **Step 2: Write the provisioning wizard**

`scripts/provision.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
pause() { read -r -p "Press Enter when done... " _; }

cat <<'INTRO'
GramScope setup.

This walks through the accounts only you can create. Nothing here is stored in
the repository: secrets go into .env.local (gitignored) and Vercel.
INTRO

step "1/5  Dedicated Telegram account"
cat <<'TXT'
Register a SEPARATE Telegram account for GramScope, with its own phone number.
Do not use your personal account: the session string this setup produces grants
full access to whatever account you log in with.

Then subscribe it to a few source channels so there is something to read.
TXT
pause

step "2/5  Telegram API credentials"
cat <<'TXT'
Open https://my.telegram.org -> API development tools, logged in as the
dedicated account. Create an application and copy api_id and api_hash.
TXT
read -r -p "TELEGRAM_API_ID: " TELEGRAM_API_ID
read -r -s -p "TELEGRAM_API_HASH: " TELEGRAM_API_HASH; echo

step "3/5  WorkOS AuthKit"
cat <<'TXT'
Create a WorkOS account at https://dashboard.workos.com, then:
  - enable AuthKit and note your AuthKit domain (the OAuth issuer);
  - under Connect, create an OAuth client and copy its client id and secret;
  - keep that client id and secret for the ChatGPT connector form.

The issuer is the URL that serves /.well-known/oauth-authorization-server.
TXT
read -r -p "WORKOS_ISSUER (e.g. https://your-app.authkit.app): " WORKOS_ISSUER
read -r -p "WORKOS_JWKS_URL: " WORKOS_JWKS_URL
read -r -p "OWNER_USER_ID (your WorkOS user id, the token 'sub'): " OWNER_USER_ID

step "4/5  Telegram session string"
cat > .env.local <<ENVFILE
TELEGRAM_API_ID=${TELEGRAM_API_ID}
TELEGRAM_API_HASH=${TELEGRAM_API_HASH}
TELEGRAM_SESSION=
WORKOS_ISSUER=${WORKOS_ISSUER}
WORKOS_JWKS_URL=${WORKOS_JWKS_URL}
OWNER_USER_ID=${OWNER_USER_ID}
MCP_RESOURCE_URL=
ENVFILE
chmod 600 .env.local
echo "Wrote .env.local (chmod 600, gitignored)."
echo
echo "Now run:  npm run telegram:login"
echo "Then paste the printed session string into TELEGRAM_SESSION in .env.local."
pause

step "5/5  Vercel"
cat <<'TXT'
Deploy, then set MCP_RESOURCE_URL to the deployed origin + /api/mcp and push
every variable to Vercel:

  vercel link
  vercel deploy --prod
  for v in TELEGRAM_API_ID TELEGRAM_API_HASH TELEGRAM_SESSION \
           WORKOS_ISSUER WORKOS_JWKS_URL OWNER_USER_ID MCP_RESOURCE_URL; do
    vercel env add "$v" production
  done
  vercel deploy --prod

Finally, in ChatGPT: Settings -> Connectors -> add a custom connector pointing
at https://<your-deployment>/api/mcp, choose OAuth, and paste the WorkOS Connect
client id and secret.
TXT
echo "Setup walkthrough complete."
```

- [ ] **Step 3: Make the wizard executable and document it**

```bash
chmod +x scripts/provision.sh
```

Append to `README.md`:

```markdown
---

## Setup

```bash
./scripts/provision.sh
```

The wizard walks through creating the dedicated Telegram account, its API
credentials, and the WorkOS AuthKit client, then writes `.env.local`.

Secrets never belong in this repository. `.env.local` is gitignored; production
values live in Vercel environment variables. The Telegram session string grants
full access to the account — treat it like a password.
```

- [ ] **Step 4: Verify the scripts parse**

Run: `bash -n scripts/provision.sh && npx tsc --noEmit scripts/create-telegram-session.ts --module esnext --moduleResolution bundler --target es2022 --skipLibCheck`
Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add Telegram session bootstrap and provisioning wizard"
```

---

### Task 11: Live verification against the real account

**Files:**
- Create: `tests/live/foundation.live.test.ts`

The fast suite already excludes this file: `npm test` runs `vitest run --exclude '**/*.live.test.ts'`, and `npm run test:live` runs `tests/live`.

**Interfaces:**
- Consumes: `listDialogs`, `getChannel`, `fetchFolders` from the telegram layer.
- Produces: nothing consumed by later tasks — this is the acceptance gate.

**Blocked until** the owner has created the dedicated Telegram account and `.env.local` holds a working `TELEGRAM_SESSION`. Do not weaken or skip these tests to make them pass without it; stop and report instead.

- [ ] **Step 1: Write the live test**

`tests/live/foundation.live.test.ts`:

```typescript
import { beforeAll, describe, expect, it } from "vitest";
import { fetchFolders } from "@/telegram/folders";
import { getChannel, listDialogs } from "@/telegram/dialogs";
import { MAX_RESPONSE_BYTES } from "@/schemas/size";

const enabled = process.env.GRAMSCOPE_LIVE === "1";
const suite = enabled ? describe : describe.skip;

suite("Foundation against the real account", () => {
  beforeAll(() => {
    if (!process.env.TELEGRAM_SESSION) {
      throw new Error("TELEGRAM_SESSION is required for live tests");
    }
  });

  it("lists dialogs", async () => {
    const { sources } = await listDialogs({ limit: 10 });
    expect(sources.length).toBeGreaterThan(0);
    expect(sources[0]!.id).toBeTruthy();
  });

  it("paginates into disjoint pages", async () => {
    const first = await listDialogs({ limit: 3 });
    if (!first.next_cursor) return;
    const second = await listDialogs({ limit: 3, cursor: first.next_cursor });
    const firstIds = new Set(first.sources.map((s) => s.id));
    for (const source of second.sources) {
      expect(firstIds.has(source.id)).toBe(false);
    }
  });

  it("keeps a max-limit page under the size cap", async () => {
    const page = await listDialogs({ limit: 200 });
    expect(
      Buffer.byteLength(JSON.stringify(page.sources), "utf8"),
    ).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
  });

  it("agrees between folder membership and folder_ids", async () => {
    const folders = await fetchFolders();
    if (folders.length === 0) return;
    const folder = folders[0]!;
    const { sources } = await listDialogs({
      folder_id: folder.id,
      limit: 200,
    });
    for (const source of sources) {
      expect(folder.included_peer_ids).toContain(source.id);
    }
  });

  it("resolves the same source by id, username and url", async () => {
    const { sources } = await listDialogs({ type: "channel", limit: 50 });
    const withUsername = sources.find((s) => s.username);
    if (!withUsername) return;

    const byId = await getChannel({ id: withUsername.id });
    const byUsername = await getChannel({ username: withUsername.username! });
    const byUrl = await getChannel({
      url: `https://t.me/${withUsername.username!}`,
    });
    expect(byUsername.id).toBe(byId.id);
    expect(byUrl.id).toBe(byId.id);
  });

  it("does not advance any read pointer", async () => {
    const before = await listDialogs({ limit: 50 });
    const pointers = new Map(
      before.sources.map((s) => [s.id, s.read_inbox_max_id]),
    );

    await fetchFolders();
    for (const source of before.sources.slice(0, 5)) {
      await getChannel({ id: source.id });
    }

    const after = await listDialogs({ limit: 50 });
    for (const source of after.sources) {
      if (!pointers.has(source.id)) continue;
      expect(source.read_inbox_max_id).toBe(pointers.get(source.id));
    }
  });
});
```

- [ ] **Step 2: Run the live suite**

Run: `GRAMSCOPE_LIVE=1 npm run test:live`
Expected: PASS (6 tests). If the account has no folders or no public channels, the relevant tests return early — that is expected, not a failure.

- [ ] **Step 3: Confirm the fast suite still excludes live tests**

Run: `npm test`
Expected: the live suite does not run; all fast-tier tests pass.

- [ ] **Step 4: Deploy and verify the metadata document**

```bash
vercel deploy --prod
curl -s https://<deployment>/.well-known/oauth-protected-resource | python3 -m json.tool
curl -s -o /dev/null -w '%{http_code}\n' https://<deployment>/api/mcp
```

Expected: the metadata document lists your AuthKit issuer under `authorization_servers`; the unauthenticated `/api/mcp` request returns `401`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test: add live verification suite for Foundation"
```

---

### Task 12: Owner acceptance in ChatGPT

**Files:** none — this task changes no code.

**Interfaces:**
- Consumes: the deployment from Task 11.
- Produces: a verified connector, or defects to fix.

These are the two acceptance criteria that cannot be automated: they happen inside ChatGPT's UI.

- [ ] **Step 1: Add the connector**

In ChatGPT: Settings → Connectors → add a custom connector at `https://<deployment>/api/mcp`, choose OAuth, and paste the WorkOS Connect client id and secret.

Expected: the OAuth flow completes and the connector lists exactly three tools — `list_dialogs`, `list_folders`, `get_channel`.

- [ ] **Step 2: Run the real question**

Ask ChatGPT: *"What channels do I have and how are they organized?"*

Expected: an answer from real account data, naming channels with unread counts and folder membership.

- [ ] **Step 3: Confirm reads did not mutate state**

Open the Telegram app on the dedicated account.

Expected: unread badges are unchanged from before Step 2.

- [ ] **Step 4: Confirm the non-owner is refused**

Sign a second WorkOS identity in, or call the endpoint with that identity's token.

Expected: `OWNER_FORBIDDEN`.

- [ ] **Step 5: Check the logs**

```bash
vercel logs <deployment> --since 15m
```

Expected: tool name, duration and result counts are present; no session string, token, or message body appears.

- [ ] **Step 6: Record the outcome and finish the branch**

Update `docs/superpowers/tasks/gramscope-mcp.md` with any defects found, then use `superpowers:finishing-a-development-branch`.

---

## Post-plan verification

Run before declaring Foundation complete:

```bash
npm test && npm run typecheck && npm run lint
GRAMSCOPE_LIVE=1 npm run test:live
```

All seven acceptance criteria in spec §9 must hold. Criteria 3 and 4 are owner-confirmed in Task 12; the rest are verified by the commands above plus the Task 11 deployment checks.
