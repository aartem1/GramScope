---
slug: gramscope-mcp
title: GramScope — personal Telegram MCP server for ChatGPT
source: README.md (development brief, commit f137b11, 2026-08-26)
branch: gramscope-mcp
created: 2026-08-26
---

# Open questions
- [x] 2026-08-26 → resolved: Telegram library is `teleproto` (maintained TypeScript fork of GramJS), not GramJS. GramJS `telegram` last published 2025-02-12; teleproto v1.229.0 published 2026-08-25 and is pure JS with no native build step.
- [x] 2026-08-26 → resolved: MCP auth is OAuth via WorkOS AuthKit with **static client credentials** pasted into ChatGPT. ChatGPT offers only OAuth / No Authentication / Mixed — no API-key option — but accepts static credentials, so neither DCR nor CIMD is required.
- [x] 2026-08-26 → resolved in the Foundation plan: `list_dialogs(folder_id)` honors a folder's included minus excluded peers only, and ignores its exclude-muted / exclude-read / chat-type flags, because those depend on live state and would make output non-reproducible. The tool description says so explicitly.
- [ ] 2026-08-26 → design: source-note serialization in the private `Source Meta` channel — human-readable post vs compact structured block; must keep stable lookup by numeric Telegram source ID.
- [ ] 2026-08-26 → owner: practical limits of global Telegram search (pagination, paid/global-search constraints) on the real dedicated account.
- [ ] 2026-08-26 → owner: which linked-discussion/comment cases are reliably reachable via the chosen Telegram library.
- [ ] 2026-08-26 → owner: create the dedicated Telegram account and hand over API_ID/API_HASH, plus GitHub and Vercel access. Owner has agreed to provide all three; work is blocked on the Telegram account existing.

# Changes and findings
- 2026-08-26 — intake: brief lives in README.md; no spec, plan, ledger, or feature branch exists yet.
- 2026-08-26 — constraint: Telegram folders cap at 10 (20 Premium) with 100 chats each (200 Premium), and are client-side peer groupings — no server-side history-by-folder. Division of labor decided for sub-projects 5 and 6: folders are the few coarse reading lanes (one `getDialogFilters` call resolves all of them, and they are what the human sees as tabs); meta-channel tags carry unbounded cross-cutting metadata (topic, type, language, quality). Neither replaces the other.
- 2026-08-26 — scope decision (owner delegated it): deliver as six sequential sub-projects, each with its own spec/plan/ledger — 1 Foundation (hosting, OAuth, session bootstrap, shared client/error/pagination/schema conventions, `list_dialogs`, `get_channel`), 2 Reading, 3 Research, 4 Discovery, 5 State writes, 6 Source metadata. Sub-project 1 fixes the conventions the rest inherit and is the only one that must survive real MTProto on serverless.

- 2026-08-26 — owner will provide Telegram credentials (once the account exists), GitHub, and Vercel access, so the live-tier tests and deployment run in-session rather than by hand. Acceptance steps performed inside the ChatGPT connector UI remain owner-run. Secret hygiene agreed: gitignored `.env.local` locally, `vercel env add` for deploys, never in chat, commits, specs, or plans; the StringSession is full account access and is never printed.

# Blocked — awaiting owner
- [ ] Create the dedicated Telegram account (needs its own phone number), then run `./scripts/provision.sh` and `npm run telegram:login` to produce `TELEGRAM_SESSION`.
- [ ] Run the live suite: `GRAMSCOPE_LIVE=1 npm run test:live`. Six tests; unmet preconditions report as SKIPPED, never as passed, so investigate any skip.
- [ ] Deploy to Vercel and confirm `/.well-known/oauth-protected-resource` names the AuthKit issuer and that `/api/mcp` returns 401 unauthenticated.
- [ ] Acceptance criteria 3 and 4 run inside ChatGPT's connector UI and cannot be automated.
- [ ] First live run must confirm `get_channel` by marked id resolves on a cold serverless instance — teleproto looks the peer up in a session entity cache that `StringSession` does not persist.

# Decisions carried into later sub-projects
- `TelegramSource.id` is Telegram's MARKED id (`-100…` for channels). Every later tool joins on this field, and sub-project 6 keys source notes by it.
- Cursors carry a kind discriminator (`k`); each new paginated tool must use its own, or a foreign cursor silently returns a wrong page.
- There is no access-hash story yet. A stateless instance has no entity cache, which blocks every write tool in sub-projects 5 and 6. Resolve before designing `mark_read`, folder edits, and joins — the answer may change what `id` means.
- `readOnlyHint` is currently uniform and unenforced. When write tools land, derive the annotation from the same value that drives behavior.

# Links
- brief: README.md
- spec (sub-project 1, Foundation): docs/superpowers/specs/2026-08-26-gramscope-foundation-design.md
- plan (sub-project 1, Foundation): docs/superpowers/plans/2026-08-26-gramscope-foundation.md
- ledger: (not created)
