# GramScope Foundation — design

Sub-project 1 of 6. Slug `gramscope-mcp`. Brief: `README.md`. Card:
`docs/superpowers/tasks/gramscope-mcp.md`.

## 1. Problem and user

One owner runs a dedicated Telegram account as an information source system and wants
ChatGPT to operate it. Nothing exists yet: no code, no Telegram account, no OAuth
provider. Until ChatGPT can authenticate to a deployed endpoint and read real dialogs
from a real account, every schema and tool decision in the brief is unvalidated.

## 2. Required outcome

A deployed MCP server on `*.vercel.app` that ChatGPT connects to over OAuth, which
exposes three read-only tools over the owner's Telegram account: `list_dialogs`,
`list_folders`, `get_channel`.

This is a walking skeleton. Its purpose is to fix the conventions — auth, error
taxonomy, cursors, entity schemas, connection lifecycle — that sub-projects 2 through 6
inherit, and to prove them against real MTProto before ~17 further tools are designed
on top.

## 3. Scope and non-goals

In scope: hosting and deployment, OAuth and owner allowlist, Telegram session
bootstrap, the shared client/error/pagination/schema layer, the three tools above, and
a provisioning wizard for the accounts that do not yet exist.

Out of scope for this sub-project:

- any tool returning message content (sub-project 2);
- any write to Telegram state — read marks, joins, folder edits, notes (sub-projects 5, 6);
- search of any kind (sub-project 3);
- channel discovery (sub-project 4);
- the `Source Meta` channel (sub-project 6).

Out of scope for the product, per brief §24: external database, mirrored archive,
vector index, background worker, realtime listener, web dashboard, multi-user support,
custom domain, VPS.

## 4. Resolved decisions

These were open in brief §25 and are settled. Reopen only on new evidence.

| Decision | Choice | Reason |
| --- | --- | --- |
| Telegram library | `teleproto` | Maintained TypeScript fork of GramJS. `telegram` (GramJS) last published 2025-02-12; teleproto v1.229.0 published 2026-08-25, pure JS, no native build step, installs on serverless runtimes. Same `StringSession` API, so brief assumptions carry over. |
| MCP auth | OAuth via WorkOS AuthKit with static client credentials | ChatGPT supports only OAuth, No Authentication, and Mixed — no API-key option — but accepts static credentials, so neither DCR nor CIMD is required. AuthKit publishes `/.well-known/oauth-authorization-server` and a JWKS URL. |
| Transport | Stateless Streamable HTTP via `mcp-handler` | The 2026-07-28 MCP revision removed HTTP+SSE and protocol-level sessions, which is what makes Vercel Functions viable. |
| Connection model | Module-scope client reuse, per-request connect as cold path | Per-request handshake on every tool call is wasteful and invites `FLOOD_WAIT`. Hidden behind `withTelegram` so the policy can change without touching tools. |
| Folder classification | Folders are reading lanes; meta-channel tags are judgement metadata | Folders cap at 10 (20 Premium), 100 chats each (200 Premium), and are client-side peer groupings with no server-side history-by-folder. One `getDialogFilters` call resolves every lane. Tags are unbounded and cross-cutting. Neither replaces the other. Applies to sub-projects 5 and 6. |

## 5. Architecture

Next.js App Router on Vercel. Two routes:

- `app/api/mcp/route.ts` — `createMcpHandler` wrapped in `withMcpAuth`, exported for GET and POST.
- `app/.well-known/oauth-protected-resource/route.ts` — `protectedResourceHandler` naming the AuthKit authorization server.

| Module | Responsibility | Hides |
| --- | --- | --- |
| `src/telegram/client.ts` | `withTelegram(fn)` — the only path to MTProto | connection reuse, cold connect, flood-wait backoff, disconnect policy |
| `src/telegram/dialogs.ts` | dialog listing, channel detail, folder membership | teleproto call shapes |
| `src/mcp/auth.ts` | JWT verification via JWKS, owner claim check | `jose`, WorkOS specifics |
| `src/mcp/tools/*.ts` | one file per tool: parse → call → map | nothing; deliberately thin |
| `src/schemas/*.ts` | zod schemas for `TelegramSource`, folders, cursors | — |
| `src/errors/*.ts` | error taxonomy and MTProto→taxonomy mapping | `RPCError` string matching |
| `src/pagination.ts` | opaque cursor encode/decode | raw MTProto offsets |
| `scripts/create-telegram-session.ts` | one-time interactive login → StringSession | — |

`withTelegram` is load-bearing: no tool may import a Telegram client directly. This is
what allows the connection policy, or the host, to change later without touching tool
code.

## 6. Functional requirements

### 6.1 Tools

```
list_dialogs { folder_id?, unread_only?, type?: "channel"|"group"|"chat", limit=50 (max 200), cursor? }
  → { sources: TelegramSource[], next_cursor? }
list_folders {}
  → { folders: [{ id, title, included_peer_ids, excluded_peer_ids, order }] }
get_channel  { id | username | url }   // exactly one
  → TelegramSource
```

`TelegramSource` follows brief §8, minus `note` (sub-project 6). Every tool declares a
zod `outputSchema` and returns `structuredContent`, supported by MCP SDK 1.30.

`list_folders` is in this sub-project because `list_dialogs(folder_id=…)` cannot be
used without a way to discover valid IDs, and `getDialogFilters` is already called to
populate `folder_ids` on each source.

Every paginated response is capped at 256 KB of serialized `structuredContent`. If a
page would exceed it, the tool returns fewer items and a `next_cursor`, rather than
truncating an item or returning an oversized payload. This bounds what a single call
can pull into ChatGPT's context regardless of `limit`.

`list_dialogs(folder_id=…)` must document exactly which folder criteria it honors —
`included_peer_ids`, `excluded_peer_ids`, and the type flags — so that ChatGPT's view
of a folder matches the owner's Telegram app.

### 6.2 Errors

Tools return `isError: true` with `structuredContent: { code, message, retry_after_seconds? }`
using the brief §16 taxonomy. `src/errors` owns the sole mapping point;
`FLOOD_WAIT_42` becomes `{ code: "RATE_LIMITED", retry_after_seconds: 42 }`. Telegram
failures are never returned as opaque HTTP 500.

### 6.3 Cursors

`base64url(JSON({ v: 1, offset_date, offset_id, offset_peer }))`. Raw MTProto offsets
are not exposed. Decode failure or version mismatch returns `INVALID_CURSOR`; it must
never silently return a wrong page.

### 6.4 Authorization

`withMcpAuth` verifies the bearer JWT against AuthKit's JWKS, checking issuer and
audience. Authorization is one comparison: token `sub` against `OWNER_USER_ID`. `sub`
is used rather than email because it is stable across address changes. No users table.

### 6.5 Secrets

`API_ID`, `API_HASH`, the StringSession, OAuth credentials, and `OWNER_USER_ID` live in
`.env.local` (gitignored) locally and in Vercel environment variables in deployment.
They never appear in chat, commits, specs, plans, tool output, or logs. The
StringSession grants full account access and is never printed.

### 6.6 Observability

Log tool name, duration, Telegram error class, result count. Never log session strings,
tokens, or message bodies.

### 6.7 Provisioning

Only the Vercel account exists. The owner must create the dedicated Telegram account
(requires its own phone number), `API_ID`/`API_HASH` at my.telegram.org, and a WorkOS
AuthKit application with one Connect client. Deliver this as an interactive wizard that
walks the owner through the steps in order and writes results into Vercel, not as
README prose.

## 7. Material states and edge cases

| State | Required behavior |
| --- | --- |
| Cold function instance | `withTelegram` connects, then serves; warm instances reuse |
| Telegram returns `FLOOD_WAIT` | mapped to `RATE_LIMITED` with `retry_after_seconds`; not retried silently |
| Tampered, stale, or foreign cursor | `INVALID_CURSOR` |
| `limit` above 200 | rejected by input schema |
| No token | 401 with `WWW-Authenticate` pointing at the protected-resource document |
| Valid token, non-owner `sub` | `OWNER_FORBIDDEN` |
| `get_channel` given zero or multiple identifiers | rejected by input schema |
| Channel absent or inaccessible | `CHANNEL_NOT_FOUND` / `PRIVATE_CHANNEL_NOT_ACCESSIBLE` |
| Account has more dialogs than one page | `next_cursor` returned; pages disjoint; terminates |

## 8. Testing

**Fast tier** — no network, every commit, drives the TDD loop:

- error mapper: table-driven `RPCError` → taxonomy, including flood-wait seconds;
- cursor codec: round-trip; tampered and version-mismatched payloads → `INVALID_CURSOR`;
- authorization: locally generated JWKS keypair via `jose`, covering the three states in §7;
- secret scrubbing: a planted session string forced through every error path never appears in output or logs;
- `withTelegram` against a fake client: cold connect, warm reuse, flood-wait surfacing;
- each tool's output mapper satisfies its declared `outputSchema`.

**Live tier** — real account, opt-in by env var, never in CI: session connects;
`list_dialogs` paginates into disjoint pages and terminates; `folder_ids` agree with
`list_folders` membership; `get_channel` by id, username, and URL return the same
source; a max-`limit` response stays within the 256 KB cap of §6.1 and returns a
`next_cursor` instead of an oversized payload.

**Read-safety invariant** (live): capture `read_inbox_max_id` across dialogs, run every
Foundation tool, re-capture, assert unchanged. Every later `mark_read` workflow depends
on reads being non-mutating.

Repository gates created by this sub-project: typecheck, lint, fast-tier tests.

## 9. Acceptance criteria

1. `npm run telegram:login` produces a StringSession from the dedicated account.
2. Deployed to `*.vercel.app`; `/.well-known/oauth-protected-resource` returns valid RFC 9728 JSON naming the AuthKit server.
3. ChatGPT's connector, configured with static client credentials, completes OAuth and lists exactly three tools.
4. In ChatGPT, "what channels do I have and how are they organized?" is answered from real data, with unread counts and folder membership.
5. A second WorkOS identity is refused with `OWNER_FORBIDDEN`.
6. Unread state in the Telegram app is unchanged after criterion 4.
7. Logs show tool name, duration, and result count, and contain no secrets.

Criteria 3 and 4 are owner-run: they happen inside ChatGPT's UI. The rest are run
against the deployment.

## 10. Open decisions

- Whether `list_dialogs` honors a folder's `exclude_muted` / `exclude_read` flags or ignores them explicitly. Decide during implementation against the owner's real folder set; document either way per §6.1.
- Warm-instance reuse window for `withTelegram` — how long a cached client stays valid before a forced reconnect. Needs a real flood-wait observation to set; start conservative.

## 11. Dependencies and risks

- **Blocked on**: the dedicated Telegram account existing. Nothing past the fast tier runs without it.
- **Risk**: warm-instance client reuse across concurrent invocations is unproven on Vercel Functions. Mitigated by `withTelegram` isolating the policy; falling back to per-request connect costs latency, not correctness.
- **Risk**: AuthKit static-credential flow with ChatGPT is documented but unverified here. First deployment tests it; failure falls back to enabling DCR or CIMD in the WorkOS dashboard.
