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

## Resume note

Planning is in progress in this file. The tasks are appended in order, and each
append is its own commit, so `git log -- docs/superpowers/plans/2026-08-27-gramscope-research.md`
shows exactly how far planning got. Planning is finished when this note is
replaced by the "Plan complete" line. If you are picking this up cold: read the
spec first, then the tasks already present, then continue numbering from the
last one written.
