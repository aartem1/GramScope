---
slug: gramscope-mcp
title: GramScope — personal Telegram MCP server for ChatGPT
source: README.md (development brief, commit f137b11, 2026-08-26)
branch: per sub-project; sub-project 1 shipped on `gramscope-mcp` and is merged into `main`
created: 2026-08-26
---

# Open questions
- [x] 2026-08-26 → resolved: Telegram library is `teleproto` (maintained TypeScript fork of GramJS), not GramJS. GramJS `telegram` last published 2025-02-12; teleproto v1.229.0 published 2026-08-25 and is pure JS with no native build step.
- [x] 2026-08-26 → resolved: MCP auth is OAuth via WorkOS AuthKit with **static client credentials** pasted into ChatGPT. ChatGPT offers only OAuth / No Authentication / Mixed — no API-key option — but accepts static credentials, so neither DCR nor CIMD is required.
- [x] 2026-08-26 → resolved in the Foundation plan: `list_dialogs(folder_id)` honors a folder's included minus excluded peers only, and ignores its exclude-muted / exclude-read / chat-type flags, because those depend on live state and would make output non-reproducible. The tool description says so explicitly.
- [ ] 2026-08-26 → design: source-note serialization in the private `Source Meta` channel — human-readable post vs compact structured block; must keep stable lookup by numeric Telegram source ID.
- [ ] 2026-08-26 → owner: practical limits of global Telegram search (pagination, paid/global-search constraints) on the real dedicated account.
- [ ] 2026-08-26 → owner: which linked-discussion/comment cases are reliably reachable via the chosen Telegram library.
- [x] 2026-08-26 → resolved 2026-08-27: the dedicated Telegram account exists and its credentials, plus GitHub and Vercel access, are in place. `.env.local` and the Vercel environment hold them; nothing was written to the repository.

# Changes and findings
- 2026-08-26 — intake: brief lives in README.md; no spec, plan, ledger, or feature branch exists yet.
- 2026-08-26 — constraint: Telegram folders cap at 10 (20 Premium) with 100 chats each (200 Premium), and are client-side peer groupings — no server-side history-by-folder. Division of labor decided for sub-projects 5 and 6: folders are the few coarse reading lanes (one `getDialogFilters` call resolves all of them, and they are what the human sees as tabs); meta-channel tags carry unbounded cross-cutting metadata (topic, type, language, quality). Neither replaces the other.
- 2026-08-26 — scope decision (owner delegated it): deliver as six sequential sub-projects, each with its own spec/plan/ledger — 1 Foundation (hosting, OAuth, session bootstrap, shared client/error/pagination/schema conventions, `list_dialogs`, `get_channel`), 2 Reading, 3 Research, 4 Discovery, 5 State writes, 6 Source metadata. Sub-project 1 fixes the conventions the rest inherit and is the only one that must survive real MTProto on serverless.

- 2026-08-26 — owner will provide Telegram credentials (once the account exists), GitHub, and Vercel access, so the live-tier tests and deployment run in-session rather than by hand. Acceptance steps performed inside the ChatGPT connector UI remain owner-run. Secret hygiene agreed: gitignored `.env.local` locally, `vercel env add` for deploys, never in chat, commits, specs, or plans; the StringSession is full account access and is never printed.

- 2026-08-27 — sub-project 1 acceptance is complete. The live suite passes 8/8 against the real account (no skips). In production `/.well-known/oauth-protected-resource` advertises `resource` = `https://gramscope.vercel.app/api/mcp` and the AuthKit issuer, and `/api/mcp` answers 401 with a `WWW-Authenticate` challenge when unauthenticated. The connector is installed in ChatGPT, OAuth completes, and a real `list_dialogs` call returned live sources with unread counts — so acceptance criteria 3 and 4, which had to be run by hand in the connector UI, are met.
- 2026-08-27 — the cold-instance question is answered in practice: `get_channel` by marked id resolves on a fresh serverless instance, so the missing entity cache does not block reads. It still blocks writes; the "no access-hash story" decision below stands unchanged for sub-projects 5 and 6.
- 2026-08-27 — operational gotcha worth keeping: ChatGPT's connector URL field was saved as `.../api/mcp,` with a trailing comma. OAuth still completed, because discovery runs off the origin rather than the path, so the connector reported itself connected and enabled while every tool call 404'd and no tools appeared. When a connector shows up healthy but exposes zero tools, check the registered URL character by character before suspecting the server.
- 2026-08-27 — the account has three Telegram folders (Новости, Технологии, AI), populated by reading each channel's recent posts rather than inferring from its title. One channel, "Example News Channel", returned no messages when sampled and was placed in Новости by name alone; that single assignment is unverified and should be re-checked once a message-reading tool exists.
- 2026-08-27 — the brand assets live in the repository: `app/icon.svg`, `public/favicon.ico`, `public/avatar-512.png` (master), `public/avatar-512-min.png` (4KB, for the plugin upload), `public/avatar-256.jpg`.

# Blocked — awaiting owner
Nothing. Every item that blocked sub-project 1 cleared on 2026-08-27; see
"Changes and findings" for what each one produced.


# Review findings not yet addressed
- No test exercises `tools/list` through the MCP handler. The units beneath it are covered, but a regression in tool registration — a bad `inputSchema`, a tool dropped from `registerTools` — would ship silently and present exactly as "connector connected, no tools available". Add one before sub-project 2 adds more tools.

# Decisions carried into later sub-projects
- `TelegramSource.id` is Telegram's MARKED id (`-100…` for channels). Every later tool joins on this field, and sub-project 6 keys source notes by it.
- Cursors carry a kind discriminator (`k`); each new paginated tool must use its own, or a foreign cursor silently returns a wrong page.
- There is no access-hash story yet. A stateless instance has no entity cache, which blocks every write tool in sub-projects 5 and 6. Resolve before designing `mark_read`, folder edits, and joins — the answer may change what `id` means.
- `readOnlyHint` is currently uniform and unenforced. When write tools land, derive the annotation from the same value that drives behavior.

# Links
- brief: README.md
- spec (sub-project 1, Foundation): docs/superpowers/specs/2026-08-26-gramscope-foundation-design.md
- plan (sub-project 1, Foundation): docs/superpowers/plans/2026-08-26-gramscope-foundation.md
- ledger: deleted with the plan workspace after the final whole-branch review came back clean, per superpowers:subagent-driven-development. Recover sub-project 1's history from `git log` if needed.
- deployment: https://gramscope.vercel.app (Vercel Git integration; a push to `main` deploys)
- MCP endpoint: https://gramscope.vercel.app/api/mcp
