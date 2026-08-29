---
slug: gramscope-mcp
title: GramScope — personal Telegram MCP server for ChatGPT
source: README.md (development brief, commit f137b11, 2026-08-26)
branch: `main`. The owner works directly on `main` until the project is fully launched (decided 2026-08-27); per-sub-project branches are not used and leftover ones were deleted.
created: 2026-08-26
---

# Open questions
- [x] 2026-08-26 → resolved: Telegram library is `teleproto` (maintained TypeScript fork of GramJS), not GramJS. GramJS `telegram` last published 2025-02-12; teleproto v1.229.0 published 2026-08-25 and is pure JS with no native build step.
- [x] 2026-08-26 → resolved: MCP auth is OAuth via WorkOS AuthKit with **static client credentials** pasted into ChatGPT. ChatGPT offers only OAuth / No Authentication / Mixed — no API-key option — but accepts static credentials, so neither DCR nor CIMD is required.
- [x] 2026-08-26 → resolved in the Foundation plan: `list_dialogs(folder_id)` honors a folder's included minus excluded peers only, and ignores its exclude-muted / exclude-read / chat-type flags, because those depend on live state and would make output non-reproducible. The tool description says so explicitly.
- [ ] 2026-08-26 → design: source-note serialization in the private `Source Meta` channel — human-readable post vs compact structured block; must keep stable lookup by numeric Telegram source ID.
- [x] 2026-08-26 → resolved 2026-08-27 by live probe, not by owner: the limits of Telegram search are measured and recorded under "Changes and findings". In short — search inside the account's own chats is free and pages cleanly; full-text search of public channels the account has not joined is Premium-only.
- [x] 2026-08-26 → resolved 2026-08-27 by live probe, not by owner: comments are reachable through the channel peer without joining anything; the discussion group itself is not addressable. Details under "Changes and findings".
- [x] 2026-08-26 → resolved 2026-08-27: the dedicated Telegram account exists and its credentials, plus GitHub and Vercel access, are in place. `.env.local` and the Vercel environment hold them; nothing was written to the repository.

# Changes and findings
- 2026-08-29 — two undocumented Telegram folder constraints, measured live in Task 12 rather than read from documentation, each reproduced with an isolated raw-teleproto call before being accepted. **A folder title is capped at 12 characters**; anything longer is rejected with `MESSAGE_TOO_LONG`, a code whose name gives no hint that a title length is what failed. **A folder cannot be created with an empty `includePeers`**; Telegram answers `FILTER_INCLUDE_EMPTY`. `createFolder` and `renameFolder` pass the title straight through to `Api.DialogFilter`, so both are wire-level limits and not GramScope bugs — but GramScope currently surfaces both as a generic `INTERNAL_ERROR`, which tells an agent nothing about how to retry. Making those two messages actionable is a candidate follow-up, deliberately left out of sub-project 5a's scope.
- 2026-08-29 — the live tier now runs its files **sequentially**, via `fileParallelism: process.env.GRAMSCOPE_LIVE !== "1"` in `vitest.config.ts`. Every live test file mutates the same real Telegram account, so concurrent files are a structural hazard, not merely a timing annoyance: a reproduced failure had `writes.live.test.ts` holding a manual unread flag through a FLOOD_WAIT stretch while `reading.live.test.ts` asserted over the same summary. The condition keys off the same environment variable that already gates every live `describe`, so `npm run test` keeps running its 30 files in parallel.
- 2026-08-26 — intake: brief lives in README.md; no spec, plan, ledger, or feature branch exists yet.
- 2026-08-26 — constraint: Telegram folders cap at 10 (20 Premium) with 100 chats each (200 Premium), and are client-side peer groupings — no server-side history-by-folder. Division of labor decided for sub-projects 5 and 6: folders are the few coarse reading lanes (one `getDialogFilters` call resolves all of them, and they are what the human sees as tabs); meta-channel tags carry unbounded cross-cutting metadata (topic, type, language, quality). Neither replaces the other.
- 2026-08-26 — scope decision (owner delegated it): deliver as six sequential sub-projects, each with its own spec/plan/ledger — 1 Foundation (hosting, OAuth, session bootstrap, shared client/error/pagination/schema conventions, `list_dialogs`, `get_channel`), 2 Reading, 3 Research, 4 Discovery, 5 State writes, 6 Source metadata. Sub-project 1 fixes the conventions the rest inherit and is the only one that must survive real MTProto on serverless.

- 2026-08-26 — owner will provide Telegram credentials (once the account exists), GitHub, and Vercel access, so the live-tier tests and deployment run in-session rather than by hand. Acceptance steps performed inside the ChatGPT connector UI remain owner-run. Secret hygiene agreed: gitignored `.env.local` locally, `vercel env add` for deploys, never in chat, commits, specs, or plans; the StringSession is full account access and is never printed.

- 2026-08-27 — sub-project 1 acceptance is complete. The live suite passes 8/8 against the real account (no skips). In production `/.well-known/oauth-protected-resource` advertises `resource` = `https://gramscope.vercel.app/api/mcp` and the AuthKit issuer, and `/api/mcp` answers 401 with a `WWW-Authenticate` challenge when unauthenticated. The connector is installed in ChatGPT, OAuth completes, and a real `list_dialogs` call returned live sources with unread counts — so acceptance criteria 3 and 4, which had to be run by hand in the connector UI, are met.
- 2026-08-27 — the cold-instance question is answered in practice: `get_channel` by marked id resolves on a fresh serverless instance, so the missing entity cache does not block reads. It still blocks writes; the "no access-hash story" decision below stands unchanged for sub-projects 5 and 6.
- 2026-08-27 — operational gotcha worth keeping: ChatGPT's connector URL field was saved as `.../api/mcp,` with a trailing comma. OAuth still completed, because discovery runs off the origin rather than the path, so the connector reported itself connected and enabled while every tool call 404'd and no tools appeared. When a connector shows up healthy but exposes zero tools, check the registered URL character by character before suspecting the server.
- 2026-08-27 — the account has three Telegram folders (id 2 Новости, id 3 Технологии, id 4 AI), populated by reading each channel's recent posts rather than inferring from its title. ~~One channel, "Example News Channel", returned no messages when sampled and was placed in Новости by name alone; that single assignment is unverified.~~ **Re-checked 2026-08-27 with `get_messages(source_ids: ["-1001111111111"], limit: 5)` now that a message-reading tool exists.** The channel posts military and political news (Peskov statements, drone warnings over Donetsk, a morning news brief); two of the five sampled posts are media-only with empty text. It sits in folder id 2, Новости, which the content confirms. No folder assignment on the account is now unverified.
- 2026-08-27 — owner decision: `mark_read` moves from sub-project 5 into sub-project 2. Without it the read pointer never advances, so `unread_only` and `get_unread_summary` would ship decorative. The owner accepted the risk on the grounds that the Telegram account is a fresh dedicated one where damaging state is acceptable.
- 2026-08-27 — the access-hash question is **verified live**, not only read from source. Task 1 of the sub-project 2 plan resolved a channel by its marked id on a deliberately cold client (`__resetClientForTests`) and invoked `channels.ReadHistory` against the real account with `maxId` set to the channel's existing read pointer — a genuine write RPC that moves no state. Telegram accepted it. `mark_read` therefore resolves peers exactly as the read path does, and no dialog-list fallback is needed. The regression guard is `tests/live/access-hash.live.test.ts` (commit 0dc0580). Note that `channels.readHistory` returns a TL `Bool` and legitimately returns `false` for a no-op maxId; a thrown mapped error, not a falsy return, is the failure signal.
- 2026-08-27 — `npm run typecheck` had been red on `main` since sub-project 1: two `DialogCursor` fixtures in `tests/telegram-dialogs.test.ts` omitted the required `boundaryIds`. Fixed in commit 4a2e78e. Every task in the sub-project 2 plan gates on typecheck, so this had to clear first.
- 2026-08-27 — the access-hash question is answered from teleproto's source, not assumed. `getInputEntity` falls through the in-memory cache and the session cache to a network path that calls `channels.getChannels` with `access_hash = 0`; Telegram accepts that for channels the account holds and returns the real hash. That is why Foundation's `get_channel` resolves on a cold instance, and the same `InputPeerChannel` is valid for writes. Cost is one extra round trip per cold peer. Task 1 of the sub-project 2 plan verifies it against the real account before any tool depends on it.
- 2026-08-27 — owner decision: no per-sub-project branches. All work lands directly on `main` until the project is fully launched. The merged branches `gramscope-mcp`, `live-test-env` and `wizard-git-deploy` were deleted, and `gramscope-reading` was fast-forwarded into `main` and deleted.
- 2026-08-27 — sub-project 2 is mid-implementation, executed with `superpowers:subagent-driven-development` directly on `main`. Tasks 1-6 of the plan are complete and reviewed; Task 7 is implemented at commit ebd222d but its review never returned before the session ended, so it must be re-reviewed rather than assumed good. Eleven commits are unpushed by design: pushing to `main` deploys to Vercel, and Task 14 of the plan is the step that does that deliberately. The per-task record, including every ruling, is in the git-ignored ledger named under Links.
- 2026-08-27 — **teleproto's `TotalList` leaks past the TL boundary.** `client.getDialogs` and `client.getMessages` return a `TotalList` (`node_modules/teleproto/Helpers.js:448`, `class TotalList extends Array`) whose constructor sets `this.total = 0`. `filter`, `map` and `slice` preserve the subclass through `Symbol.species`, so it rode all the way out to `listDialogs().sources` and `getMessage().context_before/.context_after`. `JSON.stringify` serializes an `Array` subclass as a plain array and drops `total`, so the wire response and the size cap were never wrong — the defect is a library type escaping the mapping boundary, which breaks any structural comparison against values that look identical. Found by the Task 13 live suite, not by the fast tier: every unit fake returned plain arrays. Fixed in `624a401` with `Array.from` at the two entry points, and `TelegramLike` now records the contract so a future `.map` cannot reintroduce it silently.
- 2026-08-27 — the plan's Task 13 snippet violated the live suite's own stated house rule ("every loop is preceded by an assertion or a visible `ctx.skip()` on the length of what it iterates"): the unread test's only guard, `total_unread >= 0`, is a tautology because the field sums positive counts, so with nothing unread the test passed having asserted nothing. Fixed in `ef7021f`. Worth remembering that a plan's code snippet is not self-validating — check it against the rules the same plan states.
- 2026-08-27 — sub-project 2 (Reading) is implemented and pushed: `main` moved `8b1c5ec..5243a59`, all 14 plan tasks done, every task reviewed. Fast tier 223/223, typecheck, lint and `npm run build` green; the live suite passes 16/16 with no skips against the real account. The Vercel production deployment for that push reports Ready, `/api/mcp` answers 401 with a `WWW-Authenticate` challenge, and `/.well-known/oauth-protected-resource` advertises the endpoint plus the AuthKit issuer. Spec §14 criteria 4-6 run in the ChatGPT connector UI and remain owner-run.
- 2026-08-27 — **sub-project 2 (Reading) is accepted and complete.** All 14 plan tasks landed and were reviewed. Spec §14 criteria confirmed in the ChatGPT connector against the real account: 7/7 tools registered; `get_messages` fanned one call over folder AI into 14 channels; a week-windowed read returned `is_read: true` messages without `unread_only`; `mark_read` moved "Два майора" from 39 unread to 0 and the follow-up summary reflected it; and a server-issued `next_cursor` resumed into a disjoint second page of 3 sources and 22 messages.
- 2026-08-27 — **the connector caches its tool list at install time.** Acceptance first reported 3/7 tools — exactly the sub-project 1 set as it stood when the connector was installed. The server was ruled out by reproducing the production handler construction (`createMcpHandler` + `registerTools`, the mcp-handler path rather than the `McpServer` path the unit test uses) and getting all 7 back. Reconnecting the connector fixed it. **After any change to tool names, descriptions or schemas, reconnect before testing**, or the old list is what gets exercised.
- 2026-08-27 — **cursors must be echoed verbatim, and a connector will not always do it.** Acceptance hit `INVALID_CURSOR` passing back a cursor the server had just issued. The round trip was verified correct live (166 chars, valid base64url, decodes, second page returns), so the model altered the token. Whitespace mangling already survives because Node's base64 decoder ignores it, now pinned by a regression; lost characters cannot be recovered. The `cursor` parameter therefore carries an explicit opaque-token contract in its description and the rejection message repeats it, so the caller can self-correct. Every later paginated tool should do the same.
- 2026-08-27 — operational note: `npm run build` rewrites `tsconfig.json` (Next adds `allowJs`, `incremental`, `resolveJsonModule`, `isolatedModules` and reformats the file). It is local churn, not a source change; revert it rather than committing it.
- 2026-08-27 — **Telegram search, measured live against the real account** (throwaway probes, not committed; sub-project 3 input).
  - `messages.searchGlobal` searches only chats the account participates in. Walking 12 pages x 50 for a Russian query returned 600 unique hits across 36 peers with **zero duplicates**, every one of them already in the dialog index, at 300-500 ms per page and no FLOOD_WAIT. It pages by `(offsetRate = the previous page's nextRate, offsetPeer = the last hit's peer, offsetId = the last hit's id)`; `count` is a stable total (4820 for the sample query). `broadcastsOnly` and `minDate`/`maxDate` are honored, and a bounded result comes back as `messages.Messages` with no `count` instead of a `MessagesSlice`.
  - `messages.search` (one peer) is free and pages by `offsetId`, and **works inside a public channel the account has not joined**.
  - `channels.searchPosts` with `query` — the true full-text search of all public channels — answers **PREMIUM_ACCOUNT_REQUIRED** on this account. `channels.checkSearchPostsFlood` prices it: `queryIsFree: false`, `starsAmount: 10`, `totalDaily: 10`, `remains: 10`. So it is 10 Stars per query, capped at 10 queries a day, and Premium-gated on top.
  - `channels.searchPosts` with `hashtag` **is free and unrestricted**, reaches all public channels (26.8M hits for `ai`), and pages by `nextRate` with no overlap. Its results are dominated by SEO and spam channels, so it is a weak discovery signal, not a research tool.
  - `contacts.search` is free and returns public channels the account has never joined, with `participantsCount` — the usable discovery path.
  - Reading a non-joined public channel by username works: `getMessages(@username)` and `messages.search` in it both succeed. Discovery can therefore hand a lead straight to the reading tools, provided the username travels with it.
- 2026-08-27 — **linked discussions and comments, measured live.** 34 of the account's 50 channels have a linked discussion group and the account is a member of **none** of them, which is the case that matters.
  - `messages.getReplies(peer = the CHANNEL, msgId = the post)` returns the comment thread without joining anything: `messages.ChannelMessages`, newest-first, `fromId` present, paging by `offsetId` = the oldest id of the previous page with zero overlap at 20 per page. Its `count` is live and runs slightly ahead of the post's own counter (217 vs 215).
  - The discussion group itself is **not** addressable: `getMessages` on its marked id fails with `CHANNEL_INVALID`, because the account does not hold that peer. The channel peer is the only door into the comments.
  - Every sampled post of a linked channel carries a `replies` block with `replies` (comment count), `maxId` and `channelId`, so comment counts are free — no extra RPC to decide whether a thread is worth fetching.
  - A post with zero comments and a channel with no linked group both fail `getReplies` with the same `MSG_ID_INVALID`. The two are indistinguishable by error, so the post's own `replies.replies` counter is the pre-check, not a try/catch.
  - `messages.getDiscussionMessage` maps a post to its anchor message in the discussion group and carries `maxId` / `unreadCount`; it is the join point if comment read state is ever wanted.
- 2026-08-27 — **`channels.getFullChannel` floods fast.** About 20 calls in 5 seconds triggered a 27-second FLOOD_WAIT, which teleproto absorbs by sleeping — so a fan-out over it does not fail, it silently stalls the whole request past any serverless budget. Linked-chat discovery must be cached or done in small batches, never per-source inside a tool call.
- 2026-08-27 — sub-project 3 (Research) scope decisions, taken with the owner during brainstorming. It ships `search_messages`, `get_thread`, `resolve_telegram_url` and `get_pinned_messages`. **Saved Messages reading and search move out of Slice 3 into sub-project 5**, next to `save_message`: the dedicated account's Saved Messages is empty and nothing writes to it until that tool exists, so they would ship decorative — the same argument that pulled `mark_read` into sub-project 2, applied in the other direction. Sources may be named three ways — marked id, username, or `t.me` URL — and the sub-project 2 reading tools are extended to accept all three, because a resolved link that no tool accepts is a dead end.
- 2026-08-27 — **the grouped-by-source house format is overturned for search only.** Sub-project 2 carried forward that search should match the grouped shape. A global search page is a slice of a ranked stream across all chats, so its groups would be an artifact of the page and the same source would reappear as a fresh group on every subsequent page. `search_messages` therefore returns a flat, date-ordered list plus a per-source roll-up; `get_messages` keeps its groups, where one group per requested source is stable. The rule that replaces it: the shape follows whether the page's groups are stable, not the tool's arity.
- 2026-08-27 — the owner reviewed and approved the sub-project 3 (Research) spec as written; no changes were requested. The brainstorming approval gate is closed and planning may proceed.
- 2026-08-27 — the brand assets live in the repository: `app/icon.svg`, `public/favicon.ico`, `public/avatar-512.png` (master), `public/avatar-512-min.png` (4KB, for the plugin upload), `public/avatar-256.jpg`.

- 2026-08-27 — **sub-project 3 planning is finished; implementation has not started.** The spec is approved by the owner, the plan is written, self-reviewed and committed, and `main` is clean at `d57e1a5`. No source file of sub-project 3 exists yet: nothing under `src/telegram/{peer-resolve,tl-messages,search,thread,resolve,pinned}.ts`, nothing under `src/mcp/tools/{search-messages,get-thread,resolve-telegram-url,get-pinned-messages}.ts`, and `src/mcp/server.ts` still registers seven tools. Anything the next agent finds beyond that was added after this note was written.
- 2026-08-27 — two decisions taken while writing the sub-project 3 plan that the spec does not contain, recorded here because the plan argues from them.
  - **A shared `src/telegram/tl-messages.ts`.** Four TL requests — `messages.searchGlobal`, `messages.search`, `messages.getReplies` and the pinned search — return the same union of `messages.Messages` (bounded, no `count`), `messages.MessagesSlice` (`count`, sometimes `nextRate`) and `messages.ChannelMessages` (`count`, no `nextRate`). One reader instead of the same twenty lines in three engines.
  - **`MessageCursor.sources[].sourceId` is renamed to `handle`.** It no longer holds a marked id: a channel resolved by username must keep travelling by username, because a bare marked id resolves only for peers the account holds and a fresh serverless instance would resume with one Telegram answers `CHANNEL_INVALID`. The wire key stays `i`, so cursors already issued keep decoding.
- 2026-08-27 — the sub-project 3 spec was **amended during planning** to four cursor kinds rather than two (commit `aaa6fbf`). `get_thread` and `get_pinned_messages` are paginated and §8 named a kind for neither; reusing the sub-project 2 `messages` kind would let a `get_messages` cursor decode cleanly in `get_thread` and page comments from a message id belonging to a different chat.
- 2026-08-27 — after reconnecting the ChatGPT connector, `tools/list` returned 11 tools: `list_dialogs`, `list_folders`, `get_channel`, `get_messages`, `get_message`, `get_thread`, `get_unread_summary`, `mark_read`, `search_messages`, `resolve_telegram_url`, and `get_pinned_messages`. An account-wide `search_messages` returned 10 results on page 1 and 10 on page 2; its cursor was accepted unchanged and the pages had no duplicates. A search in the AI folder (id 4) returned hits from 6 channels in one call. `get_thread` for `Example News Channel` (`@examplenewschannel`), post id 17510, returned 20 comments with `comment_count` 28. An outside source remained `joined=false` (`source_id=-1004444444444`), and `get_messages` read 5 messages from it. The production deployment `https://gram-scope-jkl456mno-example-projects.vercel.app` reached state `Ready`. `GET https://gramscope.vercel.app/api/mcp` returned `401` with `WWW-Authenticate: Bearer error="invalid_token", error_description="No authorization provided", resource_metadata="https://gramscope.vercel.app/.well-known/oauth-protected-resource"`. `GET https://gramscope.vercel.app/.well-known/oauth-protected-resource` returned `200` with `{"resource":"https://gramscope.vercel.app/api/mcp","authorization_servers":["https://your-app-staging.authkit.app"]}`.
- 2026-08-27 — **the final whole-implementation review of sub-project 3 found three Important defects that every task review had missed**, because each one only shows across module boundaries. (1) A source can be named three ways, but union-minus-exclusions, de-duplication and the 25-source ceiling all compared raw strings, so an exclusion written `@name` did not remove the folder member listed by its marked id, one peer named twice fanned out and paged twice, and the ceiling counted names rather than peers. (2) Tool descriptions offered marked ids as continuation handles, which a `joined=false` source cannot honour on a cold instance. (3) `ChatInvitePeek` exposed a `source_id` the account cannot resolve. Fixed in `71420c8..ad2bec8`. The lesson worth carrying: a per-task review sees one diff, and a contract that lives in three modules at once is exactly what it cannot see.
- 2026-08-27 — **the 25-source ceiling now counts canonical sources, so it cannot be applied before resolution.** A looser pre-resolution guard, `MAX_RAW_SOURCE_NAMES_PER_CALL` = 4x the effective one, is what bounds how many entity resolutions one call can buy, and exclusions count toward it. Every later multi-source tool inherits both limits from `src/telegram/source-selection.ts` rather than defining its own.
- 2026-08-27 — a re-siting hazard worth remembering: when a contract moves to a later layer, the tests that guarded it move too, and their fixtures must move with them. Two fan-out fixtures resolved every unknown name to the same entity, so after canonicalisation a 26-source selection collapsed to one source and the ceiling tests would have passed having asserted nothing. Distinct names must resolve to distinct peers in any fixture that exercises a ceiling.
- 2026-08-27 — **the final review's fix rounds cost three iterations, and each round's fix introduced the next round's defect.** The chain is worth keeping because every link was invisible to the fast tier. Round 1 (`71420c8..ad2bec8`) canonicalised aliases, and made an exclusion that cannot be resolved fail the whole call — the realistic path being an agent excluding an unjoined channel by the marked id it was handed, which a cold instance cannot resolve. Round 2 (`eb1f0c9..213513a`) degraded that to name-key matching, and halved a pre-resolution name ceiling to 50, which then rejected a 45-member folder with 20 members excluded (65 names counted, effective set 25) and asked for a split `folder_ids` cannot perform. Round 3 (`a4df5b7..00a2dd2`) replaced that ceiling with a lookup budget. No fast test caught any of the three; each was found by a whole-diff reviewer reading across module boundaries.
- 2026-08-27 — **a multi-source call is bounded by three checks, cheapest first, all in `src/telegram/source-selection.ts`; every later multi-source tool inherits them rather than defining its own.** (1) `MAX_SOURCE_NAMES_PER_CALL` = 1000 caps the sheer number of names, read from array lengths before any per-name work. (2) The distinct HELD selected sources, minus held exclusions and minus the count of network exclusions, are checked against `MAX_SOURCES_PER_CALL` = 25 — exact and free, because `resolveSource` answers those from the dialog index. (3) `MAX_NETWORK_RESOLUTIONS_PER_CALL` = 2x the ceiling caps the lookups that actually reach Telegram. `resolutionCost` in `src/telegram/peer-resolve.ts` classifies a name `local | network | never`, and `never` — unparseable names and invite links — is charged nothing, because it never reaches the network and diagnosing it as an overflow would ask for a split that cannot help. The module-level resolve cache is deliberately not counted as local, so a call is not legal on a warm instance and rejected on a cold one.
- 2026-08-27 — **the full 25-source ceiling cannot be applied before resolution, and the reason is worth keeping.** Two names the dialog index cannot answer may resolve to the same peer, so a count of names is an UPPER bound on the canonical result and refusing on it would refuse legal calls. Only the held half is exact. Held exclusions are subtracted or the folder-minus-members case is refused again; network exclusions are subtracted because any one of them may yet resolve to a held peer and remove it. Every direction of imprecision left in that bound makes it looser, never tighter.
- 2026-08-27 — a peer's username lookup is a per-index `Map` held in a `WeakMap` keyed on the `DialogIndex` object, first-wins, built once. It replaced a linear scan of every dialog per name, which a caller could drive: 200,000 names against a 1000-entry index went from about 4.5s of CPU to 66ms, inside a 60s `maxDuration`. Latent and unreachable today: a `DialogIndex` mutated after first use would be served a stale map, and nothing mutates one after `fetchDialogIndex` builds it.
- 2026-08-27 — **an exclusion degrades on `CHANNEL_NOT_FOUND`, and on `PRIVATE_CHANNEL_NOT_ACCESSIBLE` only when it was named by marked id** — including a `t.me/c/<id>` link, which parses to the same marked id. There the peer's identity is exactly what the caller wrote, so the degrade key is exact and a channel the account was banned from does not take the whole page down for an exclusion that is provably a no-op. Named by username it still fails the call, because no id is learned and the target stays unknown. The original rule and its reasoning:
- 2026-08-27 — **an exclusion degrades only on `CHANNEL_NOT_FOUND`.** That code means the name resolves nowhere, which is the cold-instance case the degrade path exists for. A malformed name, an invite link, a rate limit or a transport failure all leave the exclusion's status unknown, and serving content the caller asked to omit on a guess is worse than failing the call — spec §11 also mandates `INVALID_INPUT` for a bad source name, and an exclusion must not be the one place that escapes it. Two reviewers disagreed here; this is the ruling that stands.
- 2026-08-27 — a deliberate non-fix, so it is not re-raised: a bare unmarked id such as `1234567890` is not matched against a channel's marked id in `aliasKeys`. An unmarked id is not a documented source name, it fails resolution anyway, and matching it would collide with a user id, which Telegram marks as the bare id unchanged.
- 2026-08-27 — process trap: `npx prettier --write` over a directory reformatted 22 files unrelated to the change, because the repository is not prettier-clean and `npm run lint` does not enforce formatting. Format the files you edited, never a directory, or revert the rest before committing.
- 2026-08-28 — accepted residuals in sub-project 3, judged not worth a fifth fix round and recorded so they are not re-raised as defects. (a) When a selection's held half is already over the ceiling AND an exclusion is unusable, the caller is told about the ceiling rather than about the bad name; both statements are true and both are `INVALID_INPUT`, so it costs one extra round trip. (b) `25 held + 26 unjoined` names still buys up to 16 lookups before failing at 51 canonical sources — unavoidable, because all 26 could be aliases of the held peers, which would make the call legal; the 50-lookup budget bounds it. (c) If a username were transferred between two channels the account holds within one warm instance, the resolve cache and a fresh dialog index would disagree and the free held count could be inflated by one.

- 2026-08-28 — **Telegram discovery, measured live against the real account** (throwaway probe, deleted, not committed; sub-project 4 input). Do not re-probe these.
  - `contacts.search` matches NAMES, not topics: `q=AI` returned zero public channels while `q=artificial intelligence` returned nine. It is a lookup by title and username, so a tool description that lets the agent read it as a topical search engine will produce "no such channels exist" from a query that is merely too short.
  - `contacts.search` caps global results at **10** regardless of `limit`; 50 and 200 returned the same page. There is no offset or cursor parameter, so the tool is single-page by construction.
  - The `broadcasts: true` flag both filters out users and refills the quota with channels: `q=нейросети` went from 9 mixed results (4 chats, 5 users) to 10, all channels.
  - Its `Channel` objects carry `title`, `participantsCount`, `verified`, `scam`, `fake`, `restricted`, `left`, `broadcast`, `megagroup`, `min` — but **no `about`**. A description costs one `getFullChannel` per candidate.
  - `username` is often null while the active handle sits in `usernames[]` (`chatgptv`, `neiroseti` both arrived that way). Read both; `entityUsernames` in peer-id.ts already does.
  - `channels.getChannelRecommendations({channel})` returns `messages.ChatsSlice` with `count: 79` and only **10 chats** on this non-Premium account — `count` is what exists, the 10 are what is served, and there is no paging parameter to reach the rest.
  - `channels.getChannelRecommendations({})` — no channel — returns `messages.Chats` with **100 chats** and no `count`: global recommendations derived from the account's own subscriptions, untruncated.
- 2026-08-28 — the owner reviewed and approved the sub-project 4 (Discovery) spec as written; no changes were requested. The brainstorming approval gate is closed and planning may proceed.
- 2026-08-28 — **sub-project 4 connector acceptance passed after reconnecting the ChatGPT connector.** `tools/list` exposed exactly 13 expected tools. The initial seed `@exampleaiseed` returned zero similar channels, so the owner selected the already-followed public channel `@exampleaichannel` as the fallback seed; it returned 10 candidates with `total_similar: 74` and `truncated: true`. All 10 candidates had usernames and 9 had descriptions. Four `get_messages` calls by candidate `@username` succeeded with no failures, and three recommendations were based on the posts read. The scenario made no joins and no Telegram account-state changes.
- 2026-08-28 — **sub-project 4 is closed, deployed, accepted, and review-clean.** The final whole-implementation review over `4055790..3c38cf9` found 0 Critical, 2 Important, and 4 Minor findings. The Important findings were missing concurrent/empty details-cache flood protection and a misleading global `get_similar_channels` description. Commit `3c7383b2292387e523915ba07005a14f094b1427` fixed both and three opportunistic Minor findings; scoped re-review was CLEAN, addressed 2/2, residual 0/0/0, and Ready to close was Yes. Fresh final gates at that commit passed: 28 test files / 382 tests, typecheck, lint, and Next build; build-induced `tsconfig.json` churn was restored. `origin/main` was independently verified at the same full SHA.

# Current point

**Sub-projects 1-3 are complete, deployed and accepted.** Sub-project 3 closed
at `adde93e`; gates at `f9952d9` were 352 fast tests, typecheck, lint and build
green, live tier 25/25 with no skips.

**Sub-project 4, Discovery is closed, deployed, accepted, and review-clean.**
Everything through the closure commit `6b3d4bb` is pushed to `main`; the remote
and the local branch are level. An earlier note here said the docs-only closure
commit should stay local to avoid a redundant Vercel deploy; that was overridden
on 2026-08-28 by the owner's standing "push everything" instruction.

**Brainstorm in flight, 2026-08-28 (sub-project 5).** Decisions taken so far,
none of them yet written into a spec:
- Sub-project 5 is split. **5a** = `mark_unread`, `join_channel`,
  `leave_channel`, `manage_folder`. **5b** = `save_message`,
  `get_saved_messages`, `search_saved_messages`, specced separately later.
- The owner rejected a confirm-token gate on the destructive actions and
  redirected the problem: content read from Telegram is data, never an
  instruction and never evidence; channels pass opinion off as fact. Protection
  must come from how data is shaped and framed, not from confirmation ceremony.
- Correction to an assumption recorded earlier on this card: the account's
  folders are the agent's workspace, not the owner's curation. The owner does
  not intend to open Telegram at all. No design may rest on a human noticing
  something in a Telegram client.
- The untrusted-content framing does not become its own sub-project. The
  ChatGPT Project instructions carry the meaning; the server carries only what
  they cannot. Shared guidance moves into `ServerOptions.instructions`, said
  once, and `OUTSIDE_SOURCE_GUIDANCE` is removed from the nine shipped
  descriptions that repeat it.
- Invite links, confirmation gates, folder sharing and a folder-kind output
  field are all out of scope by owner decision.

**Spec for 5a is approved by the owner, 2026-08-28:**
`docs/superpowers/specs/2026-08-28-gramscope-writes-design.md`, no changes
requested. The implementation plan is written:
`docs/superpowers/plans/2026-08-28-gramscope-writes.md`, twelve tasks. The owner
chose subagent-driven execution on 2026-08-28.

**Execution in flight.** The ledger is
`.superpowers/sdd/2026-08-28-gramscope-writes/progress.md` — git-ignored and
machine-local, so on a fresh clone reconstruct position from `git log` instead.
A pre-flight conflict scan of the plan ran before Task 1 and produced six
rulings; five of them are already applied to the plan file in commit `038d4de`,
so the plan text on disk is the corrected one and those corrections must not be
re-derived. **Base commit for the whole sub-project: `d2cc3a3`.** Every commit
after it is implementation.

Outcomes below are filled in as each task closes, so another agent — Codex on
this machine, or any fresh session — can resume from the first row that is not
yet complete without re-running anything above it.

| Task | State |
| --- | --- |
| 1 Server-level instructions replace the per-tool guidance | complete, `f032556`, review clean; 385 tests |
| 2 `unread_mark` on the read side | complete, `2616025`, review clean, no findings; 388 tests |
| 3 `get_unread_summary` reports the manual flag | complete, `f42bd9c`, review clean; 392 tests |
| 4 `peerKind`, `toInputPeer`, `markUnread` engine | complete, `1432f22`..`7c6b4b0`, clean after 1 fix round; 399 tests |
| 5 `mark_unread` tool | complete, `067047d`, review clean; 400 tests, fourteen tools |
| 6 `join_channel` | complete, `f550122`..`cc46c43`, clean after 1 fix round; 405 tests, fifteen tools |
| 7 `leave_channel` | complete, `c02321a`, review clean; 409 tests, sixteen tools |
| 8 Folder round-trip rule, create/rename/delete | complete, `914ea66`; review closed by TL-constructor ruling, 2 minor test findings deferred; 417 tests |
| 9 Folder membership and order | complete, `d7f8dc9`, review clean; 431 tests |
| 10 `manage_folder` tool | complete, `546b2a9`, review clean; 433 tests, seventeen tools |
| 11 Version 1.3.0, README, deploy | complete, `690ecb6`..`3c99774`, clean after 1 fix round; 433 tests + build; deployed and verified in production |
| 12 Live tier | complete, `9c2b5ec`..`dd47f22`, clean after 1 fix round; live tier 35 passed/1 skipped, fast tier 433 |

Rulings made during execution, each of which the owner may overrule:

- Pre-flight, applied to the plan at `038d4de`: `leaveChannel`'s kind check moves
  above the membership early-return; the folder-edit test fake applies the writes
  it receives to its own filter list; Task 1 extracts a shared `connectServer`
  test helper instead of duplicating the handshake; Task 10's schema assertion
  copies the enum's array before sorting it; Task 8 implements `createFolder`
  without the `source_ids` branch, which Task 9 adds.
- Task 4: the duplicated `source_ids` validation guard is extracted into
  `src/telegram/source-selection.ts` as `assertSourceIdsBounded(ids, toolName,
  ceiling)`. **Task 9's folder editing must use that helper instead of writing
  its own `assertBatchSize`, passing `MAX_SOURCES_PER_CALL`** — the plan text
  still says `assertBatchSize`, and this ruling overrides it.
- Task 5: `tests/mcp-handler.test.ts` got a local writers array in place of a
  chain of `!==` comparisons, folded into Task 6 rather than deferred, because
  the chain would have reached five clauses by Task 10.
- Task 6: the `peerKind` guard moves above the membership branch in
  `joinChannel`, and the entity is resolved once up front for both branches.
  The plan text put the guard in only the not-held branch, so a numeric id
  naming an already-held private chat returned `already_member: true` — a
  success for a target the tool's own description says cannot be joined. Same
  shape as the pre-flight ruling for `leaveChannel`: kind is a property of the
  target, not of membership. The `sourceType` test around `fetchChannelDetails`
  disappeared with it, since every entity surviving the guard is a channel.
- Task 8: retain `pinnedPeers: []` and `excludePeers: []` when constructing a
  new `DialogFilter`, despite the spec's shorthand that create sets only `id`,
  `title` and `includePeers`. Teleproto declares all three peer vectors as
  required, non-optional constructor fields, and the Task 8 brief therefore
  supplies the two empty vectors explicitly. They carry no user-selected state.
  Cost if wrong: create writes explicit empty vectors where Telegram might have
  supplied an equivalent default; omitting them instead fails the declared TL
  constructor contract.
- Task 11: the plan's four-file list omitted `package-lock.json`, but the
  repository already treated its two root version fields as part of the tested
  public-version invariant. The lockfile therefore moves to 1.3.0 and the
  existing assertions stay; removing the assertions to preserve the plan's
  file list was rejected in review. Cost if wrong: one extra metadata file in
  the Task 11 diff. README now distinguishes five state-change tools deployed
  in 1.3.0 from the six planned for full Slice 5; `save_message` remains 5b.

**Brainstorm in flight, 2026-08-29 (sub-project 5b).** Nothing is specced yet.
The first owner decision already overrides the README's description of the
sub-project:

- **Saved Messages are not a forwarding archive.** The owner rejected the
  README's "prefer native forwarding semantics" framing outright: posts are not
  to be forwarded into Saved Messages at all. Saved Messages are to hold a
  compact, agent-written **classifier and memory about sources** — which
  channels write about what, a short summary of what a channel covers — so that
  a specific question whose answer does not fall out of the folder taxonomy can
  still be routed to the right channels. The owner's constraint on it: "не
  превращать сохраненные сообщения в свалку, там должно быть компактно и
  удобно." They are open to widening the idea, not to loosening that constraint.
- **This collides with sub-project 6** (`get_channel_note` / `set_channel_note`
  in a private `Source Meta` channel), which was specified for the same purpose
  in a different place. Resolving that overlap is the next open question; the
  two must not ship as two parallel memories of the same thing.

## How to resume sub-project 5a

Read this before dispatching anything, whether you are Codex on this machine or
a fresh session.

- The plan is `docs/superpowers/plans/2026-08-28-gramscope-writes.md`, executed
  with `superpowers:subagent-driven-development`: one implementer subagent per
  task, a spec-plus-quality review after each, a scoped re-review after each fix
  round, and one broad whole-branch review at the end.
- **The plan text on disk is already corrected.** Five pre-flight rulings were
  applied to it at `038d4de` and must not be re-derived. The rulings above,
  however, override the plan text where they conflict — the plan file was not
  rewritten for them.
- The working ledger and the per-task briefs lived in
  `.superpowers/sdd/2026-08-28-gramscope-writes/`, which was git-ignored and
  machine-local. It was **deleted** after the final re-review came back clean,
  per `superpowers:subagent-driven-development`. Its durable content — every
  ruling and every deferred item — was lifted into this card first; git history
  carries the rest.
- Resume at the first table row above that is not `complete`. Everything above
  it is committed, reviewed, and must not be redone.
- **Current point (2026-08-29):** sub-project 5a is finished apart from owner
  acceptance. All twelve tasks are complete and reviewed. The broad
  whole-sub-project review over `d2cc3a3`..`7017671` returned Needs fixes with
  three Important findings; the single fix wave closed them across `f85e101`,
  `8332274` and `74e0f56`; and the scoped re-review of that wave returned
  "All findings addressed, no new Critical/Important breakage" with the gates
  re-run independently (443/443 fast tier, typecheck, lint). Production serves
  **1.3.1**, and its `401` Bearer challenge and protected-resource document
  were re-checked after that deploy. The git-ignored ledger was deleted per
  `superpowers:subagent-driven-development`, so this card is now the whole
  durable record — the rulings and deferred items below were lifted out of it
  before deletion. **Sub-project 5a is complete, owner acceptance included.** Both
  acceptance actions passed on 2026-08-29 and nothing is outstanding; the next
  work is sub-project 5b (`save_message` and the Saved Messages reads) or 6
  (source notes in the private metadata channel).
  - **Owner acceptance, spec §12.5, passed 2026-08-29 in the ChatGPT
    connector.** The full sequence ran without a single error:
    `search_channels("космос")` → `join_channel("@examplechannel")`
    (`already_member: false`) → `manage_folder(create, title "Probe",
    source_ids ["@examplechannel"])`, which returned folder id 5 with
    `included_peer_ids: ["-1002222222222"]` → `list_dialogs(folder_id: "5")`,
    which showed the channel filed there → `leave_channel("@examplechannel")`
    (`was_member: true`) → `manage_folder(delete, folder_id: "5")`. The
    connector reported exactly seventeen tools by name. A read-only audit
    afterwards confirmed the account is back to its baseline: folders 2/17,
    3/15, 4/14, 58 dialogs, 0 manual unread flags, no membership left behind.
    This also settles the deployed-version question — seventeen tools counted
    from inside ChatGPT is the 1.3.1 acceptance check, so no second browser
    token was needed.
  - **Owner acceptance, spec §12.6, passed 2026-08-29:** the owner created the
    ChatGPT Project from `docs/chatgpt-project-instructions.md`. That file is
    now live prompt text, not a draft — every future edit to it changes the
    standing instructions of a Project that already exists, and the repository
    copy is only the source of truth for as long as the two are kept in step.
    **The Project contains everything from `## What this connector is`
    downwards and nothing above it**; the H1 and the paragraph under it are
    notes about the file, not instructions to the model. That boundary is now
    stated in the file itself, so a re-paste needs no judgement.
    Whenever a tool's accepted input changes, check that file the way the final
    fix wave had to.
  - **The throwaway WorkOS client stays.** `GramScope acceptance probe`,
    `client_id` `client_01M14EP0KM5CFN1491QE4JZ0M3`, was registered so a
    loopback `authorization_code` + PKCE flow could hold an owner token outside
    ChatGPT — AuthKit offers no `client_credentials` grant and refuses the
    device grant to DCR clients. The owner decided on 2026-08-29 to keep it
    rather than delete it, since it is the only way to query the deployed MCP
    directly. It is a public client with no secret, redirecting only to
    `http://127.0.0.1:8765/callback`, and any token it mints still has to pass
    `verifyOwnerToken`'s audience and `sub == OWNER_USER_ID` checks.

- **Final fix wave (2026-08-29), one wave only, no second round.** Fixed, all
  within the existing taxonomy: (1) `manage_folder(create)` now rejects an
  absent or empty `source_ids` with `INVALID_INPUT` naming the constraint —
  Telegram answers a zero-peer include list with `FILTER_INCLUDE_EMPTY`, so the
  advertised create-empty-then-fill sequence could never work; schema, tool
  description and README now say `source_ids` is required on create. (2) New
  `MAX_FOLDER_TITLE = 12` beside `MAX_FOLDERS`, checked in `createFolder` and
  `renameFolder`, mirrored as `.max(12)` on the zod field and stated in the tool
  description; `MESSAGE_TOO_LONG` and `FILTER_INCLUDE_EMPTY` join `EXACT` in
  `src/errors/from-telegram.ts` mapped to `INVALID_INPUT` as belt and braces.
  (3) `manage_folder(remove_sources)` no longer silently removes nothing when
  given a `@username` or a `t.me` link: **option (a) of the reviewer's two was
  taken** — every entry must be a marked id, rejected otherwise with
  `INVALID_INPUT` pointing at `list_folders`' `included_peer_ids`. Option (b),
  resolving through `resolveSource`, was rejected on inspection: `resolveSource`
  needs a `DialogIndex`, `folder-edit.ts` holds none, and building one is
  `fetchDialogIndex()` — a `messages.GetDialogFilters` plus a paged
  `getDialogs({limit: 1000})` — so it is not the free lookup the review assumed,
  and it would add the account's heaviest read to a call that today makes two
  invokes. Minors: the four drifted files formatted with an explicit
  `prettier --write` file list (never a directory — the repo is not
  prettier-clean); `WRITERS` extracted to `tests/tool-names.ts` and imported by
  both suites; `test:live` now sets `GRAMSCOPE_LIVE=1` itself so the live tier's
  `fileParallelism` serialization cannot be lost to a forgotten export. Version
  bumped to 1.3.1 in `src/mcp/version.ts`, `package.json`, both
  `package-lock.json` root fields, the `mcp-handler` assertion and the README;
  tool count stays seventeen.

- **Follow-up in the same wave.** Fix (3) falsified the standing instruction in
  `docs/chatgpt-project-instructions.md` telling the model to address every
  source by @username, so that bullet gained a clause naming
  `manage_folder(remove_sources)` as the exception and pointing at
  `list_folders`. The folder-title cap and the create-needs-sources rule were
  deliberately NOT added there: both are already in `manage_folder`'s own
  description and in the `INVALID_INPUT` message, and standing instructions cost
  context in every session including the read-only ones. `SERVER_INSTRUCTIONS`
  (`src/mcp/instructions.ts:17`) carries the same @username rule and is
  falsified the same way; it was flagged for the owner rather than changed,
  since it ships beside the tool description that overrides it. **Ruled on and
  fixed in the same wave:** `SERVER_INSTRUCTIONS` is what the client receives at
  `initialize`, so it is the more authoritative of the two texts and carries the
  same clause now, worded to match the document. Both suites that pin the
  addressing rule keep the old substring and gained an assertion on the new
  clause, proved non-vacuous by deleting the clause and watching both fail.

- **Task 11 detail (2026-08-28):** Task 11 is complete, deployment included.
  `main` was pushed to `origin/main` at `e7c1ba6`, carrying Tasks 7-11. Vercel
  production deployment `dpl_B7UzJxGm5JbMLeZtb3jXpRyRZYxP`
  (`https://gram-scope-abc123def-example-projects.vercel.app`, alias
  `https://gramscope.vercel.app`) reached `Ready`, and every part of
  acceptance criterion 3 was verified against it — see "Production acceptance
  of 1.3.0" below. Do not redo Task 11's implementation, tests, review or
  deployment. Next: Task 12, the live tier, then the broad whole-sub-project
  review over `d2cc3a3`..HEAD.

- **Production acceptance of 1.3.0, verified 2026-08-28.** Unauthenticated:
  `/api/mcp` answers `401` with a `WWW-Authenticate: Bearer` challenge naming
  the resource metadata, and `/.well-known/oauth-protected-resource` returns
  `resource` = `https://gramscope.vercel.app/api/mcp` with the AuthKit
  issuer. Authenticated as the owner: `initialize` returns `serverInfo.name`
  `gramscope`, `serverInfo.version` `1.3.0` and a 777-character `instructions`
  string; `tools/list` returns exactly seventeen tools — `get_channel`,
  `get_message`, `get_messages`, `get_pinned_messages`,
  `get_similar_channels`, `get_thread`, `get_unread_summary`, `join_channel`,
  `leave_channel`, `list_dialogs`, `list_folders`, `manage_folder`,
  `mark_read`, `mark_unread`, `resolve_telegram_url`, `search_channels`,
  `search_messages`.

- **How the authenticated check was made, and the cleanup it left.** WorkOS
  AuthKit exposes no `client_credentials` grant and refuses the device grant to
  dynamically registered clients, so the only way to hold an owner token
  outside ChatGPT is a loopback `authorization_code` + PKCE flow the owner
  approves in a browser, with `resource` set to the MCP URL so the token's
  `aud` matches what `verifyOwnerToken` demands. Doing that required
  registering a throwaway DCR client, `GramScope acceptance probe`,
  `client_id` `client_01M14EP0KM5CFN1491QE4JZ0M3`. **It still exists in the
  WorkOS environment and should be deleted** — it is not needed again unless
  this check is repeated.
- Gates for every task: `npm run test`, `npm run typecheck`, `npm run lint`.
  The live tier is excluded from `npm run test` by design and runs only in
  Task 12, with `GRAMSCOPE_LIVE=1 npm run test:live`. Never commit the
  `tsconfig.json` churn `npm run build` leaves behind.

Three points the spec left open are decided in the plan, not in the spec, and a
reviewer may overrule any of them: `leave_channel` covers channels and
supergroups only and refuses a legacy chat or a user dialog; the manual unread
flag is reported by `get_unread_summary` under `group_by: "source"` only;
`manage_folder(add_sources)` fails the whole action if any named source does not
resolve. The plan also places `toInputPeer` in `src/telegram/client.ts` and
`peerKind` in `src/telegram/peer-id.ts`, neither of which the spec's file list
names, because the teleproto-boundary rule leaves nowhere else for them.

**Next: sub-project 5, Writes.** No spec yet. Its scope, per the README tool set
and the decisions recorded above, is `mark_unread`, `join_channel`,
`leave_channel`, `manage_folder`, `save_message`, and the Saved Messages reads
(`get_saved_messages`, `search_saved_messages`) that sub-project 3 deferred here.
Sub-project 6 (source notes in the private metadata channel) follows.

- Spec `docs/superpowers/specs/2026-08-28-gramscope-discovery-design.md`,
  approved by the owner and amended at `4639fa4` for the `getFullChannel` flood
  ceiling.
- Plan `docs/superpowers/plans/2026-08-28-gramscope-discovery.md` at `56f2ee5`,
  with two pre-flight rulings on its live tier at `4055790`.
- Executed through `superpowers:subagent-driven-development`. **Base commit for
  the whole sub-project: `4055790`.** Its temporary workspace and ledger were
  removed after the clean final re-review; this card preserves the durable
  outcomes, rulings, and deferred items.

| Task | State |
| --- | --- |
| 1 Candidate schema and mapping | complete, `c26a657`, review clean |
| 2 Capped, throttled, cached enrichment | complete, `25ad447`, review clean |
| 3 `search_channels` engine | complete, `ecd0b62`, clean after 1 fix round |
| 4 `get_similar_channels` engine | complete, `2cae8b4`; final review downgraded the duplicated page-building block to deferred Minor, see below |
| 5 Expose both tools, bump to 1.2.0 | complete, `4e57eb5` |
| 6 Live tier | complete, `d7c6435`; final gates at `3c7383b` passed: 28 test files / 382 tests, typecheck, lint, and Next build; `tsconfig.json` restored |
| 7 Deploy and accept | complete: production Ready, OAuth/MCP checks and owner connector acceptance passed; final review fixed and re-reviewed clean |

Final production deployment: `dpl_Ha9w9mNsBo1wEXwqTpa1PUB78xMB`, target
`production`, status `Ready`, URL
`https://gram-scope-xyz789ghi-example-projects.vercel.app`, alias
`https://gramscope.vercel.app`. `/api/mcp` returned the expected `401`
Bearer metadata challenge and the protected-resource document was correct.

**Deferred, non-blocking:** Task 4's review found that
`src/telegram/discovery.ts:154-164` and `:190-198` carry the same
enrich / map / `fitToSizeCap` / slice block verbatim in both engines, differing
only in which array feeds the slice. The final reviewer downgraded this to
Minor and parked it until the pipeline next changes or a third caller appears.

**Do not redo:** tasks 1-7, anything in sub-projects 1-3, or any item the four
sub-project 3 fix rounds closed. The live discovery measurements under "Changes
and findings" cost real FLOOD_WAIT budget — read them rather than re-probing.

**Rulings taken on the owner's behalf so far**, preserved here: two pre-flight
rewrites of Task 6's live tests (the wall-clock cache
comparison and the every-candidate-has-a-username assertion, both flake risks);
and a ruling that the reviewer's concern about de-duplication under-reporting
`truncated` is not a real gap, because Telegram's `results` list is the one
capped at ten and its members are distinct.

## Sub-project 5a — rulings taken on the owner's behalf

Lifted from the git-ignored ledger before it was deleted. Each says what was
decided and what it costs if wrong. Rework any of them freely.

1. **T4** — the review's duplicated-guard finding beat the plan text, which
   wrote both guards out in full. The guard moved into
   `src/telegram/source-selection.ts` as `assertSourceIdsBounded(ids, toolName,
   ceiling)`, which already owns "how many sources may one call name". Cost:
   one extra import edge, and a helper with two call sites until Task 9 added
   the third.
2. **T4** — Task 9 uses that shared helper instead of writing its own
   `assertBatchSize`. Cost: Task 9's brief and its implementation diverge on a
   function name.
3. **T4** — the two Minors went into the fix round rather than the deferred
   list, because a stale docstring is a factual error the diff introduced and
   the untested `chat`/`user` branches of `toInputPeer` are the exact failure
   `peerKind` exists to prevent. Cost: a slightly larger fix diff.
4. **T5** — `tests/mcp-handler.test.ts` hardcoded `name !== "mark_read" &&
   name !== "mark_unread"`, which would have grown to five chained clauses;
   Task 6 extracted a shared writers list instead. Cost: test churn in a file
   Task 6 already touched.
5. **T6** — the Important finding beat the plan text: `joinChannel`'s
   already-member path returned `already_member: true` for a held non-channel
   peer while the not-held path rejected the same shape. The `peerKind` guard
   moved above the membership branch, as pre-flight ruling R3 had already done
   for `leaveChannel`. Kind is a property of the target, not of membership.
   Cost: `join_channel` on an already-held legacy group now errors instead of
   reporting `already_member: true` — the more informative answer, since such a
   group cannot be joined by username at all.
6. **T6** — the Minor folded into that same fix: once the kind guard runs
   first, `fetchChannelDetails` needs no type test and the wasted
   `GetFullChannel` round trip on a legacy group disappears. Cost: none.
7. **T8** — `pinnedPeers: []` and `excludePeers: []` are retained on a new
   `DialogFilter` even though the spec says create sets only
   `id`/`title`/`includePeers`, because teleproto's generated constructor
   declares all three vectors non-optional. Empty vectors carry no user state.
   Cost: create writes explicit empty vectors where Telegram might have
   defaulted them.
8. **T11** — the lockfile finding beat the plan's four-file list;
   `package-lock.json` was already part of the tested public-version invariant.
   Cost: one extra metadata file in the diff.
9. **T12** — the hung implementer was re-dispatched on the same model rather
   than escalated, because the failure was procedural (it waited on a
   background monitor instead of running the suite in the foreground) and its
   file was complete. Cost: one more wasted dispatch.
10. **T12** — the live-tier race was fixed in both halves, not either alone.
    `tests/live/reading.live.test.ts:163` asserted `unread_count > 0` for every
    source group, which Task 3 had already invalidated, so it was wrong
    independent of any race; and every live file mutates one shared real
    account, so `fileParallelism` is now off for the live tier. Cost: the live
    tier runs serially, and one assertion is looser.
11. **Final review** — the fix wave took the three Important findings plus
    Minors 1, 2 and 9 only. Cost: seven small quality items carry into
    sub-project 5b (listed below).
12. **Final review** — the version went to **1.3.1**, because production served
    1.3.0 with behaviour this wave changed and yesterday's acceptance check was
    made against 1.3.0. Tool count unchanged at seventeen. Cost: a patch
    version the spec did not explicitly authorize.
13. **Final review** — the falsified `@username` rule was corrected in
    `src/mcp/instructions.ts` as well as in the Project document.
    `SERVER_INSTRUCTIONS` is what the client receives at `initialize` on every
    session, so it is the more authoritative of the two. Cost: a few more
    tokens spent on every session, read-only ones included.

## Sub-project 5a — deferred, not blocking

Each was raised in a review, judged non-blocking, and left open on purpose. The
final reviewer re-triaged every one of them and confirmed each could stay
deferred.

- `tests/mcp-handler.test.ts` — the `initialize` test does not close its
  transport, unlike `listTools`' `try/finally`. In-memory transport; no flake
  risk.
- `src/mcp/tools/search-channels.ts:391` — prettier flipped the string
  delimiters as churn from Task 1's refactor.
- `tests/telegram-unread.test.ts` — `indexWith` uses a truthy check where
  `src/telegram/unread.ts` uses `=== true`; the production predicate is tested
  directly.
- `src/mcp/tools/mark-read.ts` and `mark-unread.ts` are structurally identical
  registration wrappers. All seventeen registration files share the shape;
  judged idiom, not defect.
- **`src/telegram/peer-resolve.ts`'s module-level resolve cache** returns a
  `ResolvedSource` without re-checking held status, so within one warm instance
  a name resolved via the network branch keeps its `entity` after a membership
  change. The final reviewer checked whether join/leave made this worse and
  found it does not: `fetchDialogIndex()` runs fresh on every call and is not
  cached, and the cache supplies only the entity and access hash, which survive
  a membership change. The residual staleness is a cached `title` on the echoed
  source.
- `tests/telegram-folder-edit.test.ts` — the create tests do not pin the exact
  constructor payload shape, and "changes the title and nothing else" asserts
  the title only; the adjacent preservation test carries the unmodelled-field
  assertions.
- `tests/live/writes.live.test.ts:115-118` uses `expect.arrayContaining` rather
  than full-set equality. Telegram does not guarantee peer order in a returned
  filter, so a stricter check would trade an assertion for a flake.
- `tests/live/writes.live.test.ts:53-76` — the join/leave restore path runs
  only when the account does not already follow the target, so the test can
  pass having verified little. Inherited from the plan's own design.
- **Vocabulary drift, now in three places:** `docs/chatgpt-project-instructions.md`
  and `src/mcp/tools/manage-folder.ts:130` say "numeric ids" where
  `src/mcp/instructions.ts` says "marked ids". "Marked id" is the project's
  precise term; unify on the next edit that touches any of them.
- **`reorder` has no live coverage** and its handling of the reserved id 0 is
  unverified. `src/telegram/folder-edit.ts` sends only the ids of real filters
  and `DialogFilterDefault` has no id, so whether Telegram expects 0 in the
  order vector was never measured. It is the one folder action of six with no
  real-account evidence.
- **`manage_folder`'s dispatcher is untested.** `src/mcp/tools/manage-folder.ts`
  holds the `required()` errors and two distinct response shapes, and no test
  drives `run()`. The engines beneath it are well covered.
- **`mark_unread` echoes the caller's own string back as `source_id`**
  (`src/telegram/read-state.ts`), so `mark_unread(["@exampleuser"])` returns
  `source_id: "@exampleuser"` with no title. Consistent with `mark_read`'s shape by
  spec §5.4, but it is the one write of four that does not satisfy §4.2's
  purpose — that a target which resolved to something other than what the
  caller meant is visible in the response.
- **`deleteFolder` pays for a re-read it discards** — `writeFilter` always
  re-fetches all filters and the delete path throws the result away. One saved
  round trip per delete.
- **`add_sources` resolves through raw `resolveEntity`, not `resolveSource`**,
  so it is the only source-naming path that skips `parseTelegramName`: an
  invite link reaches teleproto instead of GramScope's own refusal, the
  dialog-index shortcut is unused, and 25 sources cost 25 serial network
  resolutions.
- **`remove_sources` is still a silent no-op for a marked id the folder does
  not hold.** The fix wave addressed the wrong-format case only.
- **Leaving a channel does not remove it from folders**, surfaced by the
  owner's acceptance run on 2026-08-29: `leave_channel` echoed
  `folder_ids: ["5"]` for a channel it had just left, because a folder's
  `includePeers` is independent of membership. The run deleted the folder
  straight afterwards so nothing was left stale, but an agent that joins a
  channel, files it, and later leaves it will leave the folder pointing at a
  peer the account no longer holds — and `list_dialogs(folder_id)` would then
  report a source that is not in the account's dialogs. Decide in sub-project
  5b whether `leave_channel` should offer to unfile, or whether the tool
  descriptions should simply say the two are independent.
- **The 12-character title cap is measured, undocumented, and counted in
  UTF-16 code units.** If Telegram's rule is bytes, or the cap moves, the
  `MESSAGE_TOO_LONG` mapping is the only backstop.
- **`fileParallelism` serializes files, not tests within a file.** Sound as
  shipped, since no live test is marked `concurrent`; a future
  `describe.concurrent` would quietly reopen the hazard.

# Blocked — awaiting owner
Nothing. Every item that blocked sub-project 1 cleared on 2026-08-27; see
"Changes and findings" for what each one produced.


# Review findings not yet addressed
- ~~No test exercises `tools/list` through the MCP handler.~~ **Closed 2026-08-27** by Task 12 of the sub-project 2 plan, commit `1e96589`. `tests/mcp-handler.test.ts` drives a real `McpServer` over the SDK's `InMemoryTransport` and speaks raw JSON-RPC. The reviewer confirmed independently that it catches both failure modes: a dropped tool fails the exact-set assertion, and an `inputSchema` the SDK cannot convert is converted lazily *inside* the `tools/list` handler, so it turns the whole listing into a JSON-RPC error and takes the test red.

# Deferred, not blocking

Carried out of the sub-project 2 ledger, which is git-ignored and machine-local.
Each was raised in a task review, judged non-blocking, and left open on purpose.

From Task 10 (`mark_read`):
- No test exercises a TL `Bool` false return from `channels.readHistory`. A no-op `maxId` legitimately returns false, and the failure signal is a thrown mapped error rather than a falsy return, so the distinction is asserted nowhere.
- The 26-source rejection test checks only the `INVALID_INPUT` code, not that the message names the limit.
- No test pins input order under varied concurrency; ordering is currently a property of the implementation rather than a guarded contract.

From Task 12 (`tools/list` handler test):
- `waitFor` returns any JSON-RPC message with a matching id, including an error response, and the caller then reads `.result.tools`. An unconvertible `inputSchema` therefore surfaces as `Cannot read properties of undefined` and the SDK's precise diagnostic is discarded. The test still goes red; only the message is lost.
- The schema and `readOnlyHint` loops pass vacuously on an empty tools array. The suite is non-vacuous because the exact-set test covers that case, but the two tests are individually weak.
- The 200x10ms poll caps a response at 2 s, tighter than the suite's 120 s `testTimeout`, so a loaded machine fails as "no response to request 1" rather than as a timeout.
- The schema test asserts only `inputSchema`. All seven tools also register an `outputSchema` on the same conversion path, so a dropped or unconvertible one is the same class of silent ship.

# Decisions carried into later sub-projects
- `TelegramSource.id` is Telegram's MARKED id (`-100…` for channels). Every later tool joins on this field, and sub-project 6 keys source notes by it.
- Cursors carry a kind discriminator (`k`); each new paginated tool must use its own, or a foreign cursor silently returns a wrong page.
- ~~There is no access-hash story yet.~~ Superseded 2026-08-27: resolution from a bare id works for reads and writes alike, see the finding above. `id` keeps its meaning. Folder edits, joins and leaves in sub-projects 5 and 6 inherit the same resolution path. **Qualified 2026-08-27: bare-id resolution works only for peers the account already holds.** A channel it has never joined answers `CHANNEL_INVALID` by id and resolves only by username; once resolved in-process the id then works, but a fresh serverless instance loses that. So any tool that reaches outside the account's own dialogs must carry a username or resolve one first — `TelegramSource.id` alone is not a sufficient handle there.
- `readOnlyHint` is currently uniform and unenforced. Sub-project 2 makes it behaviour-derived — `false` on `mark_read`, `true` on the reads — and the handler test asserts it. Later write tools inherit that obligation.
- The grouped-by-source response shape and the per-source `offset_id` cursor introduced in sub-project 2 are the house format for every later multi-source tool, `search_messages` included.
- **Normalize teleproto's arrays with `Array.from` before they enter a domain result.** `getDialogs` and `getMessages` return an `Array` subclass carrying `total`, and the subclass survives `filter`/`map`/`slice`. A leak is invisible to the fast tier and to the wire response, so only a live run or a structural comparison catches it. Every later tool that maps a TL list into a returned value inherits this obligation.

# Links
- brief: README.md
- spec (sub-project 1, Foundation): docs/superpowers/specs/2026-08-26-gramscope-foundation-design.md
- plan (sub-project 1, Foundation): docs/superpowers/plans/2026-08-26-gramscope-foundation.md
- spec (sub-project 2, Reading): docs/superpowers/specs/2026-08-27-gramscope-reading-design.md
- spec (sub-project 3, Research): docs/superpowers/specs/2026-08-27-gramscope-research-design.md
- plan (sub-project 2, Reading): docs/superpowers/plans/2026-08-27-gramscope-reading.md
- plan (sub-project 3, Research): docs/superpowers/plans/2026-08-27-gramscope-research.md
- ledger (sub-project 2, Reading): .superpowers/sdd/2026-08-27-gramscope-reading/progress.md — git-ignored, machine-local. It opens with a "How to resume this work in another tool" block; `/sp:next` reads it automatically.
- ledger: deleted with the plan workspace after the final whole-branch review came back clean, per superpowers:subagent-driven-development. Recover sub-project 1's history from `git log` if needed.
- deployment: https://gramscope.vercel.app (Vercel Git integration; a push to `main` deploys)
- MCP endpoint: https://gramscope.vercel.app/api/mcp
