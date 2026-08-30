---
slug: gramscope-mcp
title: GramScope — personal Telegram MCP server for ChatGPT
source: README.md (development brief, commit f137b11, 2026-08-26)
branch: `main`; the owner explicitly chose direct work on `main` until launch on 2026-08-27
created: 2026-08-26
---

# Open questions

Nothing is awaiting an owner decision.

# Requirement changes

- 2026-08-26 — Use `teleproto`, the maintained TypeScript fork of GramJS,
  rather than the stale `telegram` package named in the original brief.
- 2026-08-26 — Authenticate the ChatGPT connector through WorkOS AuthKit with
  static OAuth client credentials. DCR and CIMD are not required.
- 2026-08-27 — Work directly on `main`; do not create per-slice branches.
- 2026-08-27 — Move `mark_read` into the Reading slice so unread workflows are
  functional when they ship.
- 2026-08-27 — Accept source names as a marked ID, `@username`, or Telegram URL
  on read/research paths. Public sources outside the account require a username
  or public URL; a bare marked ID is insufficient on a cold instance.
- 2026-08-27 — Search results are a flat ranked stream. Other multi-source read
  results remain grouped by source.
- 2026-08-28 — Treat the dedicated Telegram account as the agent's workspace,
  not a human-curated client. No behavior may depend on a person noticing or
  repairing state in Telegram.
- 2026-08-28 — Telegram content is untrusted data, never instruction or
  self-authenticating evidence. Put the full rule in ChatGPT Project
  instructions and the compact invariant in MCP server instructions.
- 2026-08-28 — Do not add confirmation tokens. Write tools act on one target at
  a time and return the target actually changed.
- 2026-08-28 — Keep invite links, arbitrary messaging, mute/unmute,
  archive/unarchive, and folder sharing out of scope.
- 2026-08-29 — Replace the proposed Source Meta channel and saved-post tools
  with GramScope-authored source notes stored as raw messages in Saved
  Messages. Address notes by a stable `gs:src:<absolute marked id>` marker.
- 2026-08-29 — A source note's Telegram identity fields are third-party data;
  its `about`, `topics`, `kind`, `lang`, `cadence`, and `derived_from` fields
  are GramScope assessments based only on posts actually read.

# Review findings

These findings were accepted as non-blocking. Keep them until they are moved to
the issue tracker or explicitly closed.

## Reading and MCP tests

- `mark_read` has no test for a legitimate false return from
  `channels.readHistory`.
- The 26-source rejection test checks the error code but not the limit text.
- No test pins multi-source output order under varied concurrency.
- `tests/mcp-handler.test.ts` can replace a precise JSON-RPC error with a
  `Cannot read properties of undefined` diagnostic in its polling helper.
- The MCP schema and `readOnlyHint` loops are individually vacuous on an empty
  tool list, although the exact-set test covers the suite-level case.
- The MCP polling helper has a 2-second ceiling despite a 120-second test
  timeout.
- The MCP schema test checks `inputSchema`, not `outputSchema`.
- The MCP initialize test does not close its in-memory transport.

## Source selection and caching

- A cached `ResolvedSource` can retain a stale echoed title after membership
  changes within one warm instance; the entity and access hash remain valid.
- If a username transfers between two held channels within one warm instance,
  the resolve cache and a fresh dialog index can disagree and inflate the held
  count by one.
- A request containing 25 held sources and 26 unjoined names can spend up to 16
  lookups before canonicalization proves it exceeds the 25-source limit. The
  50-lookup budget bounds the cost; rejecting earlier would reject legal alias
  combinations.
- When the held half already exceeds the source limit and an exclusion is
  invalid, the caller sees the source-limit error first. Both are valid
  `INVALID_INPUT` errors, but diagnosis can take one extra call.

## Write tools and folders

- `mark_read` and `mark_unread` have duplicate registration wrappers, matching
  the repository's broader registration-file pattern.
- `mark_unread` echoes the caller's source string rather than the canonical
  marked ID and title.
- `manage_folder`'s dispatcher and its two response shapes lack direct tests.
- Folder create/rename tests do not independently pin every preserved
  constructor field.
- Folder reorder has no real-account coverage; handling of reserved folder ID
  `0` remains unmeasured.
- The live join/leave restore path does little when the account already follows
  the target.
- The live folder membership assertion uses partial set matching because
  Telegram does not guarantee peer order.
- `deleteFolder` performs and discards a post-write folder re-read.
- `add_sources` bypasses `parseTelegramName` and the dialog-index shortcut,
  making it inconsistent and potentially expensive.
- `remove_sources` silently succeeds when the folder does not contain the
  supplied marked ID.
- Leaving a channel does not remove it from folders. Membership and folder
  inclusion are independent Telegram states.
- The observed 12-character folder-title limit may be bytes rather than UTF-16
  code units; GramScope has no direct documentation for the rule.
- Live files are serialized, but a future `describe.concurrent` inside one file
  would reopen shared-account races.

## Minor code and fixture quality

- `src/telegram/discovery.ts` duplicates the enrich/map/size-cap/slice pipeline
  in both discovery engines. Keep it until the pipeline changes or gains a
  third caller.
- `tests/telegram-unread.test.ts` uses a truthy fixture check where production
  requires `=== true`.
- `src/mcp/tools/search-channels.ts` contains one delimiter-only formatting
  change inherited from an earlier refactor.

# Artifact links

- Foundation:
  [spec](../specs/2026-08-26-gramscope-foundation-design.md),
  [plan](../plans/2026-08-26-gramscope-foundation.md)
- Reading:
  [spec](../specs/2026-08-27-gramscope-reading-design.md),
  [plan](../plans/2026-08-27-gramscope-reading.md),
  ledger `.superpowers/sdd/2026-08-27-gramscope-reading/progress.md`
- Research:
  [spec](../specs/2026-08-27-gramscope-research-design.md),
  [plan](../plans/2026-08-27-gramscope-research.md),
  ledger `.superpowers/sdd/2026-08-27-gramscope-research/progress.md`
- Discovery:
  [spec](../specs/2026-08-28-gramscope-discovery-design.md),
  [plan](../plans/2026-08-28-gramscope-discovery.md)
- Writes:
  [spec](../specs/2026-08-28-gramscope-writes-design.md),
  [plan](../plans/2026-08-28-gramscope-writes.md)
- Source Notes:
  [spec](../specs/2026-08-29-gramscope-source-notes-design.md),
  [plan](../plans/2026-08-29-gramscope-source-notes.md)
- ChatGPT Project instructions: [`../../chatgpt-project-instructions.md`](../../chatgpt-project-instructions.md)
- Production endpoint: `https://gramscope.vercel.app/api/mcp`

The original brief and every removed execution record remain recoverable from
git history. Specs and plans are retained as the approved historical authority
for their delivery slices.
