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
- [ ] 2026-08-26 → design: source-note serialization in the private `Source Meta` channel — human-readable post vs compact structured block; must keep stable lookup by numeric Telegram source ID.
- [ ] 2026-08-26 → owner: practical limits of global Telegram search (pagination, paid/global-search constraints) on the real dedicated account.
- [ ] 2026-08-26 → owner: which linked-discussion/comment cases are reliably reachable via the chosen Telegram library.
- [ ] 2026-08-26 → owner: create the dedicated Telegram account and hand over API_ID/API_HASH, plus GitHub and Vercel access. Owner has agreed to provide all three; work is blocked on the Telegram account existing.

# Changes and findings
- 2026-08-26 — intake: brief lives in README.md; no spec, plan, ledger, or feature branch exists yet.
- 2026-08-26 — constraint: Telegram folders cap at 10 (20 Premium) with 100 chats each (200 Premium), and are client-side peer groupings — no server-side history-by-folder. Division of labor decided for sub-projects 5 and 6: folders are the few coarse reading lanes (one `getDialogFilters` call resolves all of them, and they are what the human sees as tabs); meta-channel tags carry unbounded cross-cutting metadata (topic, type, language, quality). Neither replaces the other.
- 2026-08-26 — scope decision (owner delegated it): deliver as six sequential sub-projects, each with its own spec/plan/ledger — 1 Foundation (hosting, OAuth, session bootstrap, shared client/error/pagination/schema conventions, `list_dialogs`, `get_channel`), 2 Reading, 3 Research, 4 Discovery, 5 State writes, 6 Source metadata. Sub-project 1 fixes the conventions the rest inherit and is the only one that must survive real MTProto on serverless.

- 2026-08-26 — owner will provide Telegram credentials (once the account exists), GitHub, and Vercel access, so the live-tier tests and deployment run in-session rather than by hand. Acceptance steps performed inside the ChatGPT connector UI remain owner-run. Secret hygiene agreed: gitignored `.env.local` locally, `vercel env add` for deploys, never in chat, commits, specs, or plans; the StringSession is full account access and is never printed.

# Links
- brief: README.md
- spec (sub-project 1, Foundation): docs/superpowers/specs/2026-08-26-gramscope-foundation-design.md
- plan: (not created)
- ledger: (not created)
