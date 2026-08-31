# GramScope Telegram media inspection — design

Issue [#1](https://github.com/aartem1/GramScope/issues/1). Task card:
`docs/superpowers/tasks/issue-1-media.md`. Branch: `main`, following the
owner's repository-wide decision to work directly on `main`. Target release:
`1.5.0`.

## 1. Problem

GramScope's nineteen existing MCP tools can discover, read, and search Telegram
messages, but expose only cheap media metadata. A ChatGPT conversation can see
that a post contains a photo, video, voice note, or document, yet cannot inspect
the media that may contain the answer.

The feature must remain explicitly on demand. Discovery, search, thread reads,
and message reads must not start downloading media; otherwise a normal research
call could unexpectedly fan out into many large Telegram downloads.

The primary client is an ordinary ChatGPT Project chat with the GramScope MCP
app selected, not Codex, CLI, or a workspace agent. The common path therefore
optimizes for one obvious tool, one call, one bounded media artifact, and no
model-side transport decisions.

## 2. Required outcome

Add one read-only MCP tool:

```text
get_media(source_id, message_id, mode?)
```

When `mode` is omitted, the tool chooses the best inspectable representation:

- a bounded image for photos and image documents;
- one timestamp-labelled contact sheet for videos, GIFs, and video notes;
- the source bytes for bounded voice notes and audio files;
- a Telegram thumbnail for other documents when one exists;
- otherwise metadata and a short-lived original-download link.

The tool count rises from nineteen to twenty. The complete issue ships in one
release but is implemented as the ordered subtasks in §18.

## 3. Scope

In scope:

- richer, download-free media metadata on every existing message result;
- stable media identity without exposing Telegram capabilities;
- direct bounded MCP image and audio results;
- video/GIF/video-note contact sheets and exact timestamp frames;
- original photo, video, voice, audio, sticker, and document delivery;
- short-lived secure HTTP streaming with Range support;
- bounded temporary files, derivative cache, time, byte, and concurrency limits;
- live Telegram, deployed Vercel, and ordinary ChatGPT acceptance tests.

Out of scope:

- OCR, image recognition, transcription, summarization, or other server-side AI;
- audio or video transcoding for originals;
- proactive downloads during discovery, search, or reads;
- durable storage of Telegram originals or raw file references;
- a second public media tool or a required `resources/read` round trip;
- rendering Telegram's TGS animated-sticker format in the initial release.

## 4. Design principles

**One-call happy path.** Bounded media is returned in the `get_media` tool
result itself. Resource links and signed HTTPS exist only for oversized media,
client compatibility, or an explicitly requested original.

**The server chooses the representation.** The model normally omits `mode`.
The tool description tells it to call `get_media` whenever media content may
affect the answer and to leave representation selection to GramScope.

**Selectors are stable; Telegram capabilities are not.** Every retrieval starts
from `(source_id, message_id)`, resolves the peer through the existing resolver,
and refetches the raw message. `file_reference`, `access_hash`, session data,
and download locations never appear in MCP output, URLs, cache keys, or logs.

**Bound failure before work.** Declared sizes are checked before downloading;
unknown sizes are enforced while streaming. Large or slow `auto` work degrades
to a thumbnail/link rather than consuming the whole MCP request budget.

**No hidden interpretation.** GramScope provides bytes and metadata. ChatGPT
does the visual or audio interpretation if its MCP client supports the media
content type.

## 5. Message media metadata

The existing `TelegramMessage.media` shape is extended without changing the
top-level message schema:

```ts
type MessageMedia = {
  media_id?: string
  type:
    | "photo"
    | "video"
    | "gif"
    | "video_note"
    | "voice"
    | "audio"
    | "sticker"
    | "document"
    | "url"
    | string
  file_name?: string
  mime_type?: string
  size?: number
  width?: number
  height?: number
  duration_seconds?: number
  has_thumbnail?: boolean
}
```

`media_id` is present only for downloadable Telegram media. It is an opaque
`med_`-prefixed SHA-256 digest over a versioned canonical tuple containing the
source id, message id, normalized media kind, and the raw Telegram media object
id. The raw object id is used internally but never emitted. Replacing media in
an edited message changes the id; refreshing an expiring `file_reference` does
not.

Document-attribute classification remains order-sensitive:

1. animated;
2. sticker;
3. video, with `roundMessage === true` classified as `video_note`;
4. audio, with `voice === true` classified as `voice`;
5. generic document.

Width, height, and duration come from photo sizes or document attributes.
Metadata extraction must not invoke a Telegram download method and remains
inside the existing 256 KiB structured-response budget.

## 6. `get_media` input

```ts
{
  source_id: string
  message_id: number
  mode?: "auto" | "preview" | "frames" | "original" // default auto
  timestamps_seconds?: number[]                       // max 10
  max_frames?: number                                 // 1..10, default 8
}
```

`source_id` accepts the same marked id, `@username`, username, or `t.me` URL as
the existing reading tools. `message_id` is a positive integer.

The model-facing descriptions emphasize the simplest call: pass the two
selectors and normally omit every other field.

Rules:

- non-empty `timestamps_seconds` implies frame extraction even when `mode` is
  omitted;
- timestamps must be finite, non-negative, unique after millisecond rounding,
  and within the known media duration;
- timestamps are sorted chronologically for a deterministic contact sheet;
- `timestamps_seconds` combined with `mode: "original"` is `INVALID_INPUT`;
- `max_frames` controls only automatically spaced frames and defaults to eight;
- at most ten frames are ever decoded or returned.

## 7. Automatic representation

`auto` uses a deterministic media-kind switch:

- **Photo or image document:** best available Telegram size that can become a
  direct image within the inline budget. Prefer using the source thumbnail as
  is; resize only when necessary.
- **Video, GIF, video note, or video sticker:** one contact sheet of eight
  evenly spaced frames. Samples avoid the exact first and last instants by
  using `duration × (index + 1) / (count + 1)`.
- **Voice or audio:** source bytes as direct audio when the declared or measured
  file is at most 2 MiB; otherwise a signed original link without transcoding.
- **Static image sticker:** direct image preview when its source format is
  supported by ChatGPT; otherwise a thumbnail or original link.
- **TGS animated sticker:** Telegram thumbnail when present, otherwise an
  original link. Rendering TGS is not part of this release.
- **Generic document:** Telegram thumbnail when present, otherwise metadata and
  an original link. `auto` never downloads a generic document merely to inspect
  its contents.
- **URL or service media:** `NO_MEDIA` when there is no downloadable Telegram
  media object.

`preview` requests the image/thumbnail path without decoding a video.
`frames` explicitly requests the video contact sheet and uses the larger
processing budget. `original` always supplies a signed download link; for a
supported image or audio file within 2 MiB it may additionally return the
direct original content in the same call.

If video duration is unavailable and a bounded probe cannot obtain it, `auto`
falls back to the Telegram thumbnail. Explicit `frames` returns a sanitized
processing error instead of guessing timestamps.

## 8. Tool result

Structured content contains metadata only:

```ts
type GetMediaResult = {
  status: "ready" | "fallback" | "error"
  source_id: string
  message_id: number
  media?: MessageMedia
  representation?: {
    kind: "image" | "audio" | "download" | "metadata"
    mime_type?: string
    file_name?: string
    byte_size?: number
    width?: number
    height?: number
    frame_count?: number
    timestamps_seconds?: number[]
  }
  download?: {
    url: string
    expires_at: string
  }
  code?: MediaResultCode
  retryable?: boolean
  message?: string
}
```

Binary data is never duplicated into `structuredContent` or the text manifest.
The MCP `content` array contains:

1. one short text summary of the chosen representation;
2. at most one direct `image` or `audio` block; and
3. only when needed, one `resource_link` whose URI is the signed HTTPS URL.

The direct block uses the actual output MIME type. The structured representation
preserves the stable filename, source MIME, and original size for voice/audio
even though MCP's audio content block itself has no filename field.

The existing text-only `ToolResult` type is widened to MCP content types and a
media-specific result builder is added. Logging receives only tool name,
duration, status, code, media kind, and byte counts — never content, URLs,
tokens, filenames, captions, or Telegram request objects.

`get_media` has `readOnlyHint: true`; its description is deliberately short:

> Retrieve the media attached to one Telegram message when its contents may
> affect the answer. Pass `source_id` and `message_id`; normally omit `mode`
> because GramScope returns the best bounded representation automatically.

## 9. Internal resolver

The public tool calls a single media service through `withTelegram`:

```text
get_media
  -> resolve source and refetch raw message
  -> normalize internal MediaAsset
  -> choose representation
  -> cache lookup or bounded download/processing
  -> rich MCP result
```

`MediaAsset` is internal and may hold the current raw Telegram media/location,
but it cannot be serialized. Refetching the message on every tool call and every
original request refreshes expired file references. `media_id` is identity and
a cache namespace only; it is never accepted as a retrieval selector.

`TelegramLike` gains the narrow chunked-download operation needed by the
service. Production adapts teleproto's `iterDownload`; tests provide an async
iterable fake. No feature code imports teleproto outside `src/telegram/client.ts`.

The service stops reading immediately when a byte budget, deadline, or abort
signal fires. A declared file larger than the applicable limit is rejected or
degraded before the first download chunk.

## 10. Images

Photo and thumbnail selection prefers a Telegram-provided size near a 1280 px
long edge. A source image already within 2 MiB is returned without a lossy
round trip. When resizing is required, output is JPEG for opaque images and PNG
or WebP only when transparency materially matters.

The processor starts with a maximum 1600 px long edge and reduces JPEG quality,
then dimensions, until the output is at most 2 MiB. Failure to meet the cap is a
fallback to a smaller Telegram size or an original link, never an oversized MCP
response.

## 11. Video contact sheets

Video input is streamed to a unique file under the platform temporary
directory, never accumulated in a `Buffer`. One decoder invocation extracts
all requested frames. One image operation labels every cell with its timestamp
and builds a chronological grid, producing a single JPEG artifact.

The first processor candidate is native FFmpeg plus `sharp`, behind:

```ts
interface MediaProcessor {
  contactSheet(inputPath, request, signal): Promise<ProcessedImage>
}
```

The implementation begins with a deployed measurement of dependency size, cold
start, and real Telegram-video latency. The backend is accepted only if it fits
the Vercel bundle and the budgets below. A WebAssembly decoder is not the
default because it is expected to worsen cold-start and processing cost. The
interface permits replacement without changing the tool contract.

Budgets:

- `auto`: at most 64 MiB of downloaded video and a 25-second derivative
  deadline;
- explicit `frames`: at most 128 MiB and a 45-second derivative deadline;
- ten decoded frames and one output image in either mode;
- raw inline result at most 2 MiB.

The derivative deadline starts after the raw message is resolved and includes
the Telegram download, duration probe, frame decoding, labelling, and contact
sheet encoding. It is not merely an FFmpeg subprocess timeout.

If `auto` exceeds its budget, the tool returns `fallback`, a Telegram thumbnail
when available, an original link, and `PROCESSING_TIMEOUT` or
`INLINE_LIMIT_EXCEEDED`. Explicit `frames` returns `error` for the same
condition because the caller explicitly required frames.

## 12. Voice and audio

Voice and audio originals preserve Telegram's exact source bytes and encoding.
GramScope does not transcode or transcribe them.

When the source is at most 2 MiB, it is collected into a bounded buffer for the
single MCP audio block. Missing filenames are derived deterministically from
the media kind, message id, and MIME extension, for example
`voice-1234.ogg`. User-provided filenames are sanitized but otherwise
preserved. MIME and size remain in structured content.

Larger audio skips inline collection and returns the signed streaming link in
the same tool call. Originals, including small inline audio, are not entered in
the derivative cache.

## 13. Original streaming

`get_media` constructs original URLs from the origin of `MCP_RESOURCE_URL`:

```text
GET /api/media/{encrypted-token}
```

The path token is a compact JWE encrypted and authenticated with a dedicated
32-byte `MEDIA_TOKEN_SECRET`. It contains only a version, purpose, source
selector, message id, issued-at time, expiry, and owner subject. It is valid for
ten minutes. Telegram file references, access hashes, filenames, MIME types,
and session material are not token claims.

The route validates algorithm, version, purpose, owner, and expiry, then
refetches the message and streams the current media through `iterDownload`.
Expiry is checked when a request starts; a stream already in progress may
finish. Stateless tokens may be replayed during their lifetime. One-use tokens
are rejected because they require durable coordination across serverless
instances and break legitimate Range requests.

The route supports one valid byte range, returning `206`, `Content-Range`, and
the corresponding chunk interval. Unsatisfiable or multiple ranges return the
appropriate HTTP error without downloading Telegram bytes. A client disconnect
aborts iteration and cleanup.

Headers include accurate `Content-Type`, safe RFC-compatible
`Content-Disposition`, known `Content-Length`, `Accept-Ranges: bytes`,
`Cache-Control: private, no-store`, and `X-Content-Type-Options: nosniff`.
Content is served as an attachment unless a narrowly supported player requires
inline delivery.

Neither middleware nor application logging may record the media route path or
query, because the path contains a bearer capability. Application logs use a
fixed route name and coarse status only.

Direct large-file streaming is validated on the deployed Vercel plan. If the
plan's duration or response behaviour makes it unreliable, the same delivery
stages the source into private object storage with a ten-minute download URL.
The tool's `download` contract and security properties remain unchanged;
durable originals remain prohibited.

## 14. Cache, temporary storage, and concurrency

Only generated derivatives are cached. Cache keys contain `media_id`, normalized
representation parameters, output format, and a processor-version constant.
Values are temporary file paths plus non-sensitive output metadata, never raw
Telegram locations or signed URLs.

The warm-instance cache has:

- 30-minute TTL;
- 256 MiB aggregate byte ceiling;
- least-recently-used eviction;
- file deletion on expiry and eviction;
- no correctness requirement across cold starts.

An in-memory single-flight map deduplicates identical derivative work. Video
processing uses a per-instance semaphore of one initially; image/audio fast
paths do not wait behind video. Every temporary file is created with a unique
name and removed in `finally` unless it is intentionally transferred into the
derivative cache.

## 15. Errors and degradation

Expected media outcomes use the result envelope rather than raw exceptions.
`fallback` is a successful tool call: it means the requested message was found
and GramScope supplied the best bounded alternative.

Stable media codes are:

- `MEDIA_NOT_FOUND` — the selected message no longer exists;
- `NO_MEDIA` — the message has no downloadable Telegram media;
- `UNSUPPORTED_MEDIA` — the explicit representation is unsupported;
- `INLINE_LIMIT_EXCEEDED` — direct content could not fit 2 MiB;
- `PROCESSING_TIMEOUT` — the applicable processing deadline elapsed;
- `TELEGRAM_DOWNLOAD_FAILED` — Telegram or transport failed during retrieval.

Existing `INVALID_INPUT`, authentication, owner, and rate-limit taxonomy is
reused. Results state whether retrying the same call can help. Unknown errors
remain `INTERNAL_ERROR`; exception messages and Telegram request data are never
echoed.

Invalid or expired download tokens return a generic unauthorized/expired HTTP
response without distinguishing which claim failed. Missing media after a
valid token returns not found. No response reveals whether another owner's
selector exists.

## 16. ChatGPT compatibility gate

Protocol support alone does not prove that the ordinary ChatGPT MCP client will
place direct image/audio content into the model's usable context. The first
implementation subtask therefore deploys the smallest vertical slice and tests
a real Telegram photo and voice note in a normal Project chat.

The gate compares, in order:

1. direct MCP `image` / `audio` content;
2. a same-call HTTPS `resource_link`;
3. a user-download link as the last fallback.

The accepted bounded path must take exactly one `get_media` call. If neither
direct audio nor a resource link is consumable by ChatGPT, GramScope still
delivers the original voice/audio payload, but documents the client limitation.
It does not silently add server transcription, because that would violate the
issue's privacy and scope decision. An Apps SDK player is considered only in a
future explicitly approved scope; playback UI cannot by itself make the model
understand the audio.

## 17. Verification and acceptance

Unit coverage includes:

- media classification, including `roundMessage`, voice, audio, GIF, sticker,
  image document, and generic document;
- metadata dimensions/duration and stable `media_id` behaviour;
- deterministic `auto` selection and input validation;
- filename and MIME preservation/sanitization;
- inline byte enforcement before and during download;
- contact-sheet timestamps, labelling, frame count, and one-artifact output;
- token encryption, tampering, expiry, owner binding, and non-disclosure;
- Range parsing, partial streaming, cancellation, and no whole-file buffer;
- cache TTL, byte LRU, single-flight, semaphore, and temporary cleanup;
- every fallback/error code, retryability, and log redaction;
- all existing read/search operations proving zero download calls;
- the exact twenty-tool registry and MCP handler listing.

Integration tests use a fake `TelegramLike` async chunk stream and an
instrumented processor. They assert that large inputs stop at the configured
limit, originals are not cached, structured content contains no base64, and a
tool result contains at most one direct media artifact.

Live Telegram acceptance covers a photo, image document, short and oversized
video, GIF, video note, voice note below and above 2 MiB, music/audio document,
generic document, expired token, tampered token, full original, partial Range,
and aborted download.

Deployed acceptance covers FFmpeg/`sharp` bundle size and cold start, the 25/45
second processing budgets, large-original streaming on the actual Vercel plan,
and log inspection for capability leakage.

Ordinary ChatGPT Project-chat acceptance asks the model to inspect a real
photo, describe a short video through its contact sheet, and use a voice/audio
payload. Bounded media must require one `get_media` call with omitted `mode`.
The final report records which media blocks the client actually consumed rather
than inferring support from protocol conformance.

The usual `typecheck`, lint, unit suite, production build, live suite, and
deployed smoke tests must all pass before release.

## 18. Ordered implementation subtasks

1. **ChatGPT vertical slice:** widen rich MCP results; add minimal metadata,
   resolver, and photo/voice `get_media`; deploy and measure direct content
   versus resource link in an ordinary Project chat.
2. **Metadata and identity:** complete schema enrichment and download-free
   mappings for every media kind; add registry and regression coverage.
3. **Images and audio:** finish `auto`, image selection/resizing, bounded source
   audio, stable filenames, and rich output contracts.
4. **Originals:** add JWE capability URLs, chunked Telegram streaming, Range,
   cancellation, headers, and Vercel large-file validation or private staging.
5. **Video:** measure and select the processor, then implement contact sheets,
   explicit timestamps, processing limits, and graceful degradation.
6. **Cache and hardening:** add derivative LRU/TTL, single-flight, concurrency,
   cleanup, sanitized errors, and log-redaction tests.
7. **End-to-end release:** run real Telegram and ChatGPT acceptance, update
   README/deployment documentation and environment examples, set package and
   MCP server versions to `1.5.0`, and verify exactly twenty tools.

Each subtask is part of issue #1 and the same release. They are not separate
GitHub issues or independently shipped slices.

## 19. Configuration and compatibility

One required environment variable is added:

```text
MEDIA_TOKEN_SECRET=<base64url-encoded 32 random bytes>
```

The public media origin is derived from the already required
`MCP_RESOURCE_URL`; no second public URL setting is needed. Processing and
cache limits are code constants for the initial release so deployment cannot
silently change the user-visible contract. A private-object-store fallback may
add provider credentials only if the deployed streaming gate fails.

The existing MCP server stack already supports rich content and resource
links. `TelegramLike` is extended rather than bypassed, and all production
Telegram access remains within `withTelegram`. Existing tool result callers
remain source-compatible when the common result type is widened.

## 20. Rejected alternatives

**One tool per media type.** Rejected because ChatGPT would have to classify
media and choose among several tools before retrieving it.

**Resource-first MCP workflow.** Rejected as the default because it can require
a second resource read and relies on undocumented ordinary-ChatGPT behaviour.
It remains a compatibility fallback.

**Always return originals inline.** Rejected because MCP binary content is
base64 encoded, the hosting response is bounded, and video has no direct MCP
content type.

**Expose Telegram file references or access hashes.** Rejected because they
expire, are capability-bearing internals, and create a security and caching
contract the caller does not need.

**Buffer then upload.** Rejected for large originals because memory grows with
file size and the request can fail after paying the full download cost.

**Transcribe voice on the server.** Rejected by scope: GramScope supplies the
source payload; interpretation belongs to the caller.

**Durable original cache.** Rejected because it expands privacy exposure and is
not needed for correctness. Only bounded derivatives receive warm ephemeral
caching.
