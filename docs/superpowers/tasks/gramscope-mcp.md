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
- 2026-09-03 — `AUTH_KEY_DUPLICATED` is not an IP-address condition. Telegram
  destroys the auth key when one authorized session sends requests in parallel
  from two main-DC connections, from the same or different addresses
  (<https://core.telegram.org/api/errors>). Every earlier statement in the code
  and README describing it as "the same session on two IPs" is wrong, and no
  egress-shaping measure can fix it.
- 2026-09-03 — Move all Telegram execution to one always-on worker process on
  the owner's VPS. Vercel keeps the MCP protocol, OAuth, tool schemas, and
  media capability tokens, and stops holding a Telegram session at all.
- 2026-09-03 — The Vercel-to-worker channel uses mutual TLS with a private CA
  bound to the VPS IP address. The owner declined to buy a domain, so no
  publicly trusted certificate is available and media bytes are proxied through
  Vercel rather than served from the VPS.
- 2026-09-03 — Keep exactly one `/api/mcp` endpoint. Per-consumer endpoints for
  ChatGPT and Grok were considered and dropped: the worker makes them
  unnecessary, and they would force a connector reconnect.
- 2026-09-03 — The ChatGPT connector and the Grok bot must keep working without
  being reconnected or reauthorized. The `tools/list` payload therefore stays
  byte-identical, and `MCP_RESOURCE_URL`, the WorkOS audience and
  `MEDIA_TOKEN_SECRET` are not changed. This is an acceptance gate, enforced by
  a golden fixture rather than by review.
- 2026-09-03 — The worker runs under systemd on a glibc host. Docker was
  considered and dropped as unnecessary indirection for a single process.
- 2026-09-03 — The whole system must be installable, updatable, configurable
  and diagnosable through one CLI entry point that drives both hosts, so no
  procedure requires reading the runbook and retyping commands across two
  machines. It supersedes `scripts/provision.sh`.
- 2026-09-03 — That CLI must be fully usable unattended (`--yes`, values as
  flags, `--json` output), because the owner intends to delegate deployment to
  an agent. Interactive prompting is a fallback, not the mechanism.
- 2026-09-03 — The worker reports the account's active authorization count on
  `/health`, and `doctor` fails when it is not one. This is the only signal
  that predicts auth-key destruction instead of reporting it afterwards.

# Review findings

These findings were accepted as non-blocking. Keep them until they are moved to
the issue tracker or explicitly closed.

## Dead code and stale entry points (2026-09-03)

Found while auditing the repository ahead of the worker split. None of these
block the split; all are owner decisions because they touch shipped behaviour.

- The v1 media token API is dead. `issueMediaToken` and `verifyMediaToken` in
  `src/media/token.ts` have no production caller — only
  `tests/media-token.test.ts`. The link-only amendment stopped issuing v1
  tokens, and v1 tokens live ten minutes, so none can exist. Removing v1 would
  also drop the `payload.v === 1` branch in `claimsFromPayload`, the
  `claims.v === 2` guards in both media routes, and one arm of the
  `VerifiedMediaCapability` union. Deferred rather than done: it changes what
  the media routes accept on a released version, and the split does not need
  it.
- The bare `telegram:login` npm alias was removed on 2026-09-03. It duplicated
  `telegram:login:local` under a name that did not say which mount it wrote,
  and in this repository choosing the wrong mount costs an auth key. Only
  historical specs and plans referenced it, and those are not rewritten.
- A scan for exports referenced only inside their own file flagged about
  seventy-five symbols. Almost all are the input and output types of domain
  functions, which the operation registry is about to consume, so they are not
  dead. The ones worth a second look are unrelated to that: `MediaLink` in
  `src/media/service.ts`, `sourceBlockSchema` in
  `src/mcp/tools/get-messages.ts`, `MEDIA_MODES` and
  `mediaRepresentationSchema` in `src/schemas/media.ts`,
  `messageMediaSchema` and `forwardedFromOf` in `src/schemas/message.ts`,
  `discoveredSourceSchema` in `src/schemas/discovery.ts`,
  `MAX_MEDIA_TOOL_RESULT_BYTES` in `src/mcp/media-result.ts`, and the unused
  processor test seams in `src/media/ffmpeg-processor.ts` (`FrameRunner`,
  `SpawnFfmpeg`, `SpawnContactSheet`, `createContactSheetAssembler` and
  neighbours).

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
