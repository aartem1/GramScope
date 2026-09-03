# GramScope media acceptance journal

This document separates recorded facts from acceptance work that still needs a
real Telegram fixture, a deployed request, or an ordinary ChatGPT Project chat.
Never paste signed media URLs, JWE tokens, Telegram session data, filenames from
private messages, `file_reference`, `access_hash`, or media bytes here.

## Recorded evidence

- Date recorded: 2026-08-31.
- Production deployment: `dpl_GR8C7aQ1NqcFwJxz3WcfEqPfZv1h`, status `Ready`.
- Measured deployment bundles: `api/mcp` 38.04 MiB and `api/media` 1.28 MiB.
- Historical local run before Task 7: 591 passing tests out of 620 collected;
  the remaining tests were skipped live tests.
- Selected processor in the deployed code: native `ffmpeg-static` plus `sharp`,
  with one decoder process per contact sheet and request-scoped temporary files.
- The deployment status and bundle sizes alone do not prove real-media latency,
  direct streaming, Range behaviour, log redaction, or ChatGPT consumption.

## Local Task 7 quality gate

Record the final command results here only after they have completed:

- Fast tests: 649/649 passed on 2026-09-01 after the real-Telegram ID and
  progressive-photo fixes.
- TypeScript: passed on 2026-09-01 after the production build completed.
- Lint: passed on 2026-09-01.
- Production build: passed on 2026-09-01 and included `/api/mcp` and
  `/api/media/[token]`.
- Live harness without opt-in selectors: 57/57 skipped across eight files on
  2026-09-01; no Telegram connection was attempted.
- Explicit real-account media suite: all 17 runnable cases passed on
  2026-09-01 using ten deliberate per-kind selector pairs distributed across
  sources. The sticker case remains explicitly skipped because bounded
  read-only discovery found no sticker fixture.

## Real Telegram and deployed Vercel acceptance

As of 1.6.0 the in-process live harness (`tests/live`, `GRAMSCOPE_LIVE`) was
removed: it opened a second MTProto connection against the production session.
Accept media through ChatGPT or Grok against the deployed worker instead.

Historical recorded real-account results on 2026-09-01 (pre-worker-split live
harness):

- all 17 runnable photo, image-document, video, oversized-video, video-note,
  GIF, voice, large-voice, audio, document, original, Range, token-integrity,
  expiry, and cancellation checks passed;
- the full-photo response returned 171,114 bytes matching `Content-Length`;
- the cancellation check observed the real Telegram iterator's `finally`
  path after the response reader was cancelled;
- the sticker case is the only missing fixture and remains a release gate.

Recorded production-route results against
`dpl_GR8C7aQ1NqcFwJxz3WcfEqPfZv1h` on 2026-09-01:

- a 79,872,693-byte original streamed with status 200 and exact
  `Content-Length`; two measured complete transfers took 36.4 and 53.4
  seconds;
- `bytes=0-1048575` returned status 206, exactly 1,048,576 bytes, and a valid
  `Content-Range`; measured response times were 1.43 and 1.36 seconds;
- cancelling after the first streamed chunk returned control in 5 ms; together
  with the real-account iterator-closure check above, this confirms propagation
  through both the deployed HTTP boundary and the Telegram iterator;
- tampered and expired capabilities both returned 401 before media delivery;
- five raw deployment-log lines retained none of the exact issued
  capabilities, selected source/message identifiers, response
  `Content-Disposition`, filenames, sampled binary fingerprints,
  `file_reference`, or `access_hash`.

The direct-original route is accepted for this deployment. The remaining
deployed MCP checks are the ordinary-ChatGPT photo/video/voice calls below,
which also provide the client-visible cold/warm video timings.

## Ordinary ChatGPT Project-chat acceptance

Pending owner-run verification. Refresh the custom connector actions after the
deployment, select GramScope for each message, replace the placeholders with the
actual non-secret source and message values, and send:

```text
Inspect the Telegram photo identified by its effective GRAMSCOPE_LIVE_PHOTO_SOURCE (or GRAMSCOPE_LIVE_MEDIA_SOURCE fallback) and GRAMSCOPE_LIVE_PHOTO_MESSAGE_ID in the acceptance setup, and describe what is visible.
Inspect the Telegram video identified by its effective GRAMSCOPE_LIVE_VIDEO_SOURCE (or GRAMSCOPE_LIVE_MEDIA_SOURCE fallback) and GRAMSCOPE_LIVE_VIDEO_MESSAGE_ID in the acceptance setup, and summarize only what the returned frames establish.
Inspect the Telegram voice message identified by its effective GRAMSCOPE_LIVE_VOICE_SOURCE (or GRAMSCOPE_LIVE_MEDIA_SOURCE fallback) and GRAMSCOPE_LIVE_VOICE_MESSAGE_ID in the acceptance setup. Tell me whether usable audio was delivered; do not infer content from filename or metadata.
```

For each prompt, append a dated entry containing:

- ChatGPT surface and plan;
- exact GramScope tool call names and count;
- returned MCP content types (`text`, `image`, `audio`, `resource_link`);
- first-call and warm latency;
- whether the model actually used the returned artifact;
- fallback used, if any.

Acceptance requires exactly one `get_media` call for each bounded photo, video,
and voice request. Protocol conformance is not evidence that ordinary ChatGPT
consumed the bytes. If direct audio and the same-call resource link are both
unusable, record that client limitation and confirm the original link remains
downloadable; do not add transcription.
