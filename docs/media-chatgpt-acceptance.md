# GramScope media acceptance journal

This document separates recorded facts from acceptance work that still needs a
real Telegram fixture, a deployed request, or an ordinary ChatGPT Project chat.
Never paste signed media URLs, JWE tokens, Telegram session data, filenames from
private messages, `file_reference`, `access_hash`, or media bytes here.

## Recorded evidence

- Date recorded: 2026-08-31.
- Production deployment: `dpl_2oojoxMHUiwVUTH7g9B2sXF7mp1j`, status `Ready`.
- Measured deployment bundles: `api/mcp` 38.04 MiB and `api/media` 1.28 MiB.
- Historical local run before Task 7: 591 passing tests out of 620 collected;
  the remaining tests were skipped live tests.
- Selected processor in the deployed code: native `ffmpeg-static` plus `sharp`,
  with one decoder process per contact sheet and request-scoped temporary files.
- The deployment status and bundle sizes alone do not prove real-media latency,
  direct streaming, Range behaviour, log redaction, or ChatGPT consumption.

## Local Task 7 quality gate

Record the final command results here only after they have completed:

- Fast tests: 620/620 passed on 2026-08-31.
- TypeScript: passed on 2026-08-31 after the production build completed.
- Lint: passed on 2026-08-31.
- Production build: passed on 2026-08-31 and included `/api/mcp` and
  `/api/media/[token]`.
- Live harness without opt-in selectors: 57/57 skipped across eight files on
  2026-08-31; no Telegram connection was attempted.
- Explicit real-account media suite: pending owner-provided selectors.

## Real Telegram and deployed Vercel acceptance

Pending. The operator must populate all `GRAMSCOPE_LIVE_*` selectors from
`.env.example` with deliberately chosen messages in the dedicated account, then
run `GRAMSCOPE_LIVE=1 npm run test:live`.

The deployed gate must additionally record, without retaining capability URLs:

- bounded photo, image document, video, GIF, video note, voice, audio, document,
  and sticker outcomes;
- cold and warm duration, input bytes, and output bytes for one short MP4, one
  GIF, and one video note;
- one full original larger than 2 MiB and one `bytes=0-1048575` response;
- cancellation evidence showing Telegram iteration stopped;
- application and platform log inspection confirming that no signed URL, JWE,
  filename, media bytes, `file_reference`, or `access_hash` was retained.

The direct-original route is not accepted until the large-file and log checks
above pass. If platform access logs retain the bearer path, release 1.5.0 is
blocked pending an approved private-staging design; an unnamed storage fallback
is not acceptable.

## Ordinary ChatGPT Project-chat acceptance

Pending owner-run verification. Refresh the custom connector actions after the
deployment, select GramScope for each message, replace the placeholders with the
actual non-secret source and message values, and send:

```text
Inspect the Telegram photo identified by GRAMSCOPE_LIVE_MEDIA_SOURCE and GRAMSCOPE_LIVE_PHOTO_MESSAGE_ID in the acceptance setup, and describe what is visible.
Inspect the Telegram video identified by GRAMSCOPE_LIVE_MEDIA_SOURCE and GRAMSCOPE_LIVE_VIDEO_MESSAGE_ID in the acceptance setup, and summarize only what the returned frames establish.
Inspect the Telegram voice message identified by GRAMSCOPE_LIVE_MEDIA_SOURCE and GRAMSCOPE_LIVE_VOICE_MESSAGE_ID in the acceptance setup. Tell me whether usable audio was delivered; do not infer content from filename or metadata.
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
