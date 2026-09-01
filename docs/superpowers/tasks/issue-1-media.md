---
slug: issue-1-media
title: Add on-demand Telegram media inspection over MCP
source: https://github.com/aartem1/GramScope/issues/1
branch: `main`; inherits the owner's repository-wide decision to work directly on `main`
created: 2026-08-30
---

# Open questions

- [ ] 2026-08-30 → implementation: in an ordinary ChatGPT Project chat, verify direct MCP `ImageContent` and `AudioContent` consumption and compare it with `resource_link`; the accepted happy path must require only one `get_media` call for bounded media. Pending owner-run ordinary-ChatGPT acceptance; no client result has been inferred from protocol support.
- [ ] 2026-08-30 → implementation: choose a Vercel-compatible video frame decoder after measuring bundle size, cold start, and processing time. Native `ffmpeg-static` plus `sharp` is selected in code and the deployed `api/mcp` bundle is 38.04 MiB, but cold/warm real-video timings for MP4, GIF, and video note remain pending.
- [x] 2026-09-01 → implementation: direct streaming is accepted on deployment `dpl_GR8C7aQ1NqcFwJxz3WcfEqPfZv1h`. A 79,872,693-byte original completed twice with exact length, a one-MiB Range returned 206 with a valid `Content-Range`, deployed cancellation returned control in 5 ms, the real Telegram iterator closed on cancellation, and sampled raw deployment logs retained none of the tested capabilities, selectors, filenames, media fingerprints, `file_reference`, or `access_hash`. Private staging is not needed for the measured deployment.

# Changes and findings

- 2026-08-30 — existing read and search tools expose media metadata only; their approved designs explicitly prohibit downloading media files.
- 2026-08-30 — delivery decision: ship the complete issue as one release, decomposed into separate implementation subtasks rather than separate issues or releases.
- 2026-08-30 — voice/audio originals preserve Telegram's source bytes and encoding; GramScope supplies an accurate MIME type, size, and stable sensible filename but does not transcode by default.
- 2026-08-30 — superseded architecture decision: initially preferred MCP resource links for bounded derivatives and signed HTTPS for originals; the later ChatGPT-first decision below replaces resource links as the bounded-media default.
- 2026-08-30 — target-client clarification: GramScope media is primarily consumed in an ordinary ChatGPT Project chat, not CLI, Codex, or Work mode; minimize tool calls, schema choices, latency, and reasoning burden.
- 2026-08-30 — architecture revision: make bounded direct MCP image/audio content the intended one-call ChatGPT path; retain resource links and signed HTTPS only where client interoperability or file size requires them.
- 2026-08-30 — approved ChatGPT-first contract: `get_media(source_id, message_id, mode?)` defaults to deterministic `auto`; bounded photos/images return direct image content, videos/GIFs/video notes return one labelled contact sheet, and bounded voice/audio returns source bytes as direct audio content. Generic documents return a thumbnail when available. Oversized or unsupported content returns metadata plus a short-lived signed download URL in the same call.
- 2026-08-30 — approved interaction constraint: the bounded happy path is exactly one tool call and one media artifact; `preview`, `frames`, and `original` remain optional expert/follow-up controls rather than decisions required from ChatGPT.
- 2026-08-30 — approved default inline budget: target at most 2 MiB of raw binary content per result to leave headroom for base64 and the hosting response limit; combine requested video timestamps into a single labelled contact sheet.
- 2026-08-30 — approved processing budgets: `auto` may inspect at most 64 MiB of input video for 25 seconds; explicit `frames` may use at most 128 MiB for 45 seconds; both remain capped at 10 frames and one inline artifact.
- 2026-08-30 — approved fast-path degradation: when `auto` cannot build a video contact sheet within budget, return the available Telegram thumbnail plus original-download metadata instead of failing the whole tool call.
- 2026-08-30 — approved implementation shape: stream video into a bounded temporary file, extract all frames in one decoder run, assemble one JPEG contact sheet, deduplicate identical concurrent work with single-flight, and bound warm-instance derivative caching to 256 MiB with a 30-minute TTL.
- 2026-08-30 — approved decoder gate: isolate processing behind `MediaProcessor`; evaluate native FFmpeg plus `sharp` first and require deployed Vercel measurements before committing to that backend.
- 2026-08-30 — approved original-delivery security: issue encrypted, authenticated, stateless capability tokens valid for 10 minutes; never place Telegram capability data in the token or response, and never log tokens, URLs, or media bytes.
- 2026-08-30 — approved original streaming contract: refetch the Telegram message, stream with bounded chunks, support HTTP Range and client cancellation, preserve safe MIME/filename metadata, and send private/no-store plus nosniff headers.
- 2026-08-30 — approved hosting fallback: validate direct large-file streaming on the deployed Vercel plan in this delivery; if it is not reliable, stage originals in short-lived private object storage without changing the `get_media` contract.
- 2026-08-30 — implementation-plan gate: a failed direct-streaming or URL-redaction acceptance test blocks the release before video work; private staging requires a named provider, an explicit ten-minute deletion mechanism, and an approved spec/plan amendment rather than an improvised backend.
- 2026-08-30 — approved response envelope: use `ready`, `fallback`, or `error`, a small stable error-code set, a `retryable` flag, and sanitized explanations with no internal exception details.
- 2026-08-30 — approved delivery order: one `1.5.0` release implemented through seven ordered subtasks, beginning with a deployed photo/voice vertical slice in an ordinary ChatGPT Project chat and ending with live Telegram, Vercel, and ChatGPT acceptance.
- 2026-08-30 — approved audio compatibility rule: if ordinary ChatGPT consumes neither direct MCP audio nor a same-call resource link, still deliver the original source payload and document the client limitation; do not add server transcription or an Apps SDK UI without separate scope approval.
- 2026-08-30 — issue requires explicit, on-demand retrieval through one generic `get_media` tool; discovery remains download-free and under the existing 256 KB budget.
- 2026-08-30 — voice and audio original retrieval is mandatory in the first media-download slice; GramScope provides the file and metadata but does not transcribe it.
- 2026-08-30 — retrieval uses `(source_id, message_id)` and refetches the Telegram message; raw `file_reference`, `access_hash`, session data, and capability-bearing internals never enter MCP output.
- 2026-08-30 — large originals must stream or otherwise remain bounded; generated previews and frames may use only short-lived bounded derivative caches.
- 2026-08-30 — transport finding: MCP `resources/read` represents binary content as base64 `blob`, so it is suitable only for bounded derivatives; originals require a separate authenticated/signed HTTPS streaming route.
- 2026-08-30 — dependency finding: the installed MCP server stack supports `resource_link`, resource templates, and `registerResource`; no SDK replacement is required for the resource path.
- 2026-08-31 — local implementation through Task 6 is present on `main`; the recorded pre-Task-7 run had 591 passing tests out of 620 collected, with live tests skipped.
- 2026-08-31 — deployment `dpl_2oojoxMHUiwVUTH7g9B2sXF7mp1j` reached `Ready`; measured function bundles were 38.04 MiB for `api/mcp` and 1.28 MiB for `api/media`. These measurements do not close the latency or streaming gates.
- 2026-08-31 — Task 7 adds explicit live selectors and never scans Telegram for fixtures. Real Telegram, ordinary ChatGPT, large-original Range, cancellation, cold/warm latency, and deployed log-redaction evidence remain release blockers and are tracked in `docs/media-chatgpt-acceptance.md`.
- 2026-08-31 — Task 7 local gate: 620/620 fast tests passed; typecheck, lint, and production build passed; the no-opt-in live harness discovered and skipped 57/57 tests without contacting Telegram.
- 2026-08-31 — implementation commit sequence through hardening: `6bb4ab5`, `07af415`, `028d807`, `a514cab`, `1f8e1f3`, `2eca510`, `b09e8d2`, `5b2a970`, `dc72456`, `56ddef9`, `eca7099`, and `a18317d`. Task 7 is a preparation commit until the external gates pass.
- 2026-09-01 — read-only fixture discovery found useful media candidates across different Telegram sources; no single source covered the eleven required kinds and no sticker fixture was found. The live harness therefore accepts explicit per-kind source overrides, runs only complete pairs by default, and retains `GRAMSCOPE_LIVE_STRICT=1` for the full legacy-shaped gate. It still never scans or guesses fixtures, and no pending acceptance gate is closed by a partial run.
- 2026-09-01 — selector-adaptation gate: 629/629 fast tests, typecheck, lint, production build, and shell syntax validation passed. The unconfigured media harness skipped all 18 tests without Telegram access; a partial photo selector ran only its configuration test under a safe name filter and skipped the other 17.
- 2026-09-01 — real-account gate: all 17 runnable cases passed after hardening teleproto bigint media IDs and progressive photo byte sizing; the sticker case is the sole missing fixture. The current fast gate is 649/649 with typecheck, lint, and production build passing.
- 2026-09-01 — direct-original production gate: the current Ready deployment streamed a 79,872,693-byte original with exact length, served an exact one-MiB Range with status 206, propagated client cancellation, rejected tampered/expired capabilities with 401, and exposed none of the tested capability, selector, filename, sampled-media, `file_reference`, or `access_hash` values in raw deployment logs. See the acceptance journal for timings.

# Links

- Issue: `https://github.com/aartem1/GramScope/issues/1`
- Voice/audio requirement: `https://github.com/aartem1/GramScope/issues/1#issuecomment-5467452008`
- Approved design: `docs/superpowers/specs/2026-08-30-telegram-media-design.md`
- Implementation plan: `docs/superpowers/plans/2026-08-30-telegram-media.md`
- Acceptance journal: `docs/media-chatgpt-acceptance.md`
- Existing Reading design: `docs/superpowers/specs/2026-08-27-gramscope-reading-design.md`
- Existing Research design: `docs/superpowers/specs/2026-08-27-gramscope-research-design.md`
