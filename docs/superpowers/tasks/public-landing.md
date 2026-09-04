---
slug: public-landing
title: Public GramScope repository and interactive landing page
source: description only — owner request in Codex, 2026-09-04
branch: `main`; the owner explicitly approved direct work on `main` on 2026-09-04
created: 2026-09-04
---

# Open questions

Nothing is awaiting an owner decision.

# Changes and findings

- 2026-09-04 — requirement: make the GitHub repository public without exposing
  the owner's Telegram account, credentials, private infrastructure details, or
  operational access.
- 2026-09-04 — requirement: add a high-quality interactive Vercel landing page
  with concise copy, strong visual storytelling, self-hosting guidance, and a
  GitHub link.
- 2026-09-04 — constraint: the landing page must coexist with the existing MCP
  endpoint and must not change the frozen `tools/list` payload.
- 2026-09-04 — requirement: use English only across the landing page and the
  public repository; audit the tracked repository content before publication.
- 2026-09-04 — requirement: position GramScope as compatible with AI clients
  that support its remote MCP transport and OAuth flow. Present ChatGPT and
  Grok Bot as tested examples, not as the complete compatibility set.
- 2026-09-04 — content principle: state each fact once. Do not repeat the same
  security, architecture, capability, or setup claim across landing sections.
- 2026-09-04 — responsive requirement: use intrinsic, content-driven layout
  rules and component-level container queries so the landing works across
  narrow, square, short, and wide viewports without horizontal overflow.
- 2026-09-04 — acceptance baseline: no horizontal page or component scrolling
  at standard viewport widths from 320 px upward; vertical document scrolling
  remains expected on short and narrow screens.
- 2026-09-04 — owner approved hosting the landing page at `/` in the existing
  Next.js/Vercel project. Existing MCP, OAuth metadata, media, and worker routes
  remain isolated and unchanged.
- 2026-09-04 — owner approved keeping the existing Git author email in all
  historical commits; it is already intentionally public on the GitHub profile,
  so the repository history will not be rewritten for email privacy.
- 2026-09-04 — owner selected the MIT License for the public repository.
- 2026-09-04 — owner explicitly approved implementing this slice directly on
  `main`, with the binding requirement that MCP remain working at every stage.
  Nothing may be pushed until all local acceptance gates pass.
- 2026-09-04 — owner approved
  `docs/superpowers/specs/2026-09-04-public-landing-design.md` and requested the
  next pipeline stage.
- 2026-09-04 — owner assigned implementation code to Cursor. This Codex task
  must finish the design, plan, and execution handoff without writing
  application code; the checked-in documents must let Cursor complete the
  release without reconstructing prior conversation context.

# Links

- Approved design:
  `docs/superpowers/specs/2026-09-04-public-landing-design.md`
- Implementation plan:
  `docs/superpowers/plans/2026-09-04-public-landing.md`
- Existing production architecture:
  `docs/superpowers/specs/2026-09-03-telegram-worker-split-design.md`
- Operations runbook: `docs/operations.md`
