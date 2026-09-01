# Telegram Media Link-Only Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every successful `get_media` binary MCP response with one compact `resource_link` while preserving secure originals and moving image/video materialization into a separate heavy HTTP route.

**Architecture:** `get_media` becomes a lightweight planner: it refetches message metadata, deterministically chooses one representation, issues one encrypted capability, and returns no bytes. The existing original route streams source bytes; a new view route owns Sharp/FFmpeg processing, derivative caching, time/byte limits, and sanitized HTTP errors. The MCP route must not import the heavy materializer or trace FFmpeg assets.

**Tech Stack:** TypeScript 5.6, Next.js 15 Route Handlers, MCP server 2.x, Zod 4, JOSE JWE, teleproto, Sharp, ffmpeg-static, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-30-telegram-media-design.md`

## Global Constraints

- The primary client is an ordinary ChatGPT Project chat, not Codex, CLI, or a work agent.
- A successful or fallback media result contains one text part and exactly one `resource_link`; it contains no `image`, `audio`, embedded resource, base64, or other media bytes.
- The complete serialized MCP result stays below 32 KiB.
- `get_media` performs no Telegram byte download and no Sharp/FFmpeg work.
- `auto` maps photos/images/static stickers to an image view, videos/GIFs/video notes to one eight-frame JPEG contact sheet, voice/audio to the original, and documents to a supported original or thumbnail/original fallback.
- `original` returns one original-file link. `preview` returns one image/thumbnail link. `frames` returns one contact-sheet link and remains capped at ten frames.
- Capabilities expire after ten minutes, remain owner-bound, contain no Telegram file reference/access hash/filename/source MIME, and may be replayed while valid.
- Existing version-1 original capabilities remain valid until natural expiry; all newly issued capabilities use the exact version-2 representation schema.
- The original route retains single-Range support and streaming cancellation. Generated views return `200` and may ignore Range.
- Generated images/contact sheets are at most 2 MiB. Video input budgets remain 64 MiB/25 seconds for `auto` and 128 MiB/45 seconds for explicit `frames`.
- No external object store, transcription, OCR, media interpretation, additional public media tool, or MCP `resources/read` round trip is added.
- Keep exactly twenty MCP tools and package/MCP version `1.5.0`.
- Work directly on `main`, as explicitly approved for this repository.

## File Structure

- `src/media/representation.ts` — pure, lightweight classification from `MediaAsset` plus `GetMediaInput` to one exact representation plan.
- `src/media/token.ts` — strict JWE version-2 representation capabilities plus backward-compatible version-1 original verification.
- `src/media/service.ts` — lightweight `get_media` orchestration and link/result construction only.
- `src/media/materializer.ts` — all bounded image/contact-sheet generation, cache, single-flight, semaphore, and temporary-file work moved out of the MCP import graph.
- `src/media/view-route.ts` — version-2 view-capability validation, refetch, materialization, response headers, and safe status mapping.
- `src/media/original-route.ts` — source streaming for version-1 legacy and version-2 `original` claims only.
- `src/mcp/media-result.ts` — one text part plus one resource link, never binary content.
- `src/schemas/media.ts` — public link-only representation schema; legacy `INLINE_LIMIT_EXCEEDED` remains parseable but is not newly emitted.
- `app/api/media/view/[token]/route.ts` — thin Node.js route wrapper for `handleViewRequest`.
- `next.config.ts` — trace FFmpeg worker assets into the view route rather than `/api/mcp`.
- `scripts/check-media-traces.mjs` — production-build assertion that MCP does not trace FFmpeg and the view route does.
- `tests/media-representation.test.ts` — pure representation-planning matrix.
- `tests/media-token.test.ts` — strict v2 round trips, legacy v1 verification, wrong-route rejection, expiry, tampering, and extra-claim rejection.
- `tests/media-view-route.test.ts` — view generation, fallback, limits, headers, cache behaviour, and sanitized errors.
- `tests/media-service.test.ts` — lightweight MCP planner/output contract and zero-download regression tests; existing byte/materializer cases move to the view-route suite.
- `tests/media-original-route.test.ts` — legacy/v2 original claims, Range, cancellation, and rejection of view claims.
- `tests/live/media.live.test.ts` — link-only live calls and explicit HTTP materialization.
- `README.md`, `docs/chatgpt-project-instructions.md`, `docs/media-chatgpt-acceptance.md`, `docs/superpowers/tasks/issue-1-media.md` — user/model instructions and recorded acceptance evidence.

The issue spans planner, materializer, and deployment boundaries, but they share one capability contract and cannot ship independently. Keep one amendment plan with four reviewer-gated tasks.

---

### Task 1: Exact representation plans and version-2 capabilities

**Files:**
- Create: `src/media/representation.ts`
- Create: `tests/media-representation.test.ts`
- Modify: `src/media/token.ts`
- Modify: `tests/media-token.test.ts`

**Interfaces:**
- Consumes: `MediaAsset` from `src/telegram/media.ts`; `GetMediaInput` and media limits from `src/schemas/media.ts`.
- Produces: `MediaRepresentationPlan`, `planMediaRepresentation(asset, input)`, `MediaCapabilityClaims`, `issueMediaCapability(claims, now?, key?)`, and `verifyMediaCapability(token, now?, key?)`.

- [ ] **Step 1: Write the failing representation matrix**

Create `tests/media-representation.test.ts` with table-driven assertions for the exact automatic mapping and explicit-mode validation:

```ts
import { describe, expect, it } from "vitest";
import { planMediaRepresentation } from "@/media/representation";
import type { MediaAsset } from "@/telegram/media";

const asset = (type: string, mimeType?: string, hasThumbnail = false): MediaAsset => ({
  sourceId: "-1001",
  messageId: 7,
  sourceHandle: "@news",
  descriptor: {
    media_id: `med_${type}`,
    type,
    ...(mimeType ? { mime_type: mimeType } : {}),
    ...(hasThumbnail ? { has_thumbnail: true } : {}),
  },
  rawMessage: { id: 7 },
  rawMedia: { className: "MessageMediaDocument" },
});

describe("media representation planning", () => {
  it.each([
    [asset("photo", "image/jpeg"), { kind: "image", source: "auto" }],
    [asset("video", "video/mp4"), { kind: "contact_sheet", maxFrames: 8 }],
    [asset("gif", "video/mp4"), { kind: "contact_sheet", maxFrames: 8 }],
    [asset("video_note", "video/mp4"), { kind: "contact_sheet", maxFrames: 8 }],
    [asset("voice", "audio/ogg"), { kind: "original" }],
    [asset("audio", "audio/mpeg"), { kind: "original" }],
    [asset("document", "application/pdf"), { kind: "original" }],
    [asset("document", "application/octet-stream", true), { kind: "image", source: "thumbnail" }],
    [asset("document", "application/octet-stream"), { kind: "original" }],
  ])("plans one automatic representation", (media, expected) => {
    expect(planMediaRepresentation(media, {
      source_id: "-1001",
      message_id: 7,
      mode: "auto",
      max_frames: 8,
    })).toMatchObject(expected);
  });

  it("keeps explicit frame timestamps in the capability plan", () => {
    expect(planMediaRepresentation(asset("video", "video/mp4"), {
      source_id: "-1001",
      message_id: 7,
      mode: "frames",
      max_frames: 4,
      timestamps_seconds: [8, 2],
    })).toEqual({
      kind: "contact_sheet",
      mode: "frames",
      maxFrames: 4,
      timestampsSeconds: [2, 8],
    });
  });
});
```

- [ ] **Step 2: Run the representation test and verify the red state**

Run: `npx vitest run tests/media-representation.test.ts`

Expected: FAIL because `src/media/representation.ts` does not exist.

- [ ] **Step 3: Add the pure planner with an explicit document allowlist**

Create `src/media/representation.ts` with these exported types and switch. Use `mediaError("UNSUPPORTED_MEDIA", ..., false)` for invalid explicit modes; do not inspect raw Telegram capability fields:

```ts
export type MediaRepresentationPlan =
  | { kind: "original" }
  | { kind: "image"; source: "auto" | "thumbnail" }
  | {
      kind: "contact_sheet";
      mode: "auto" | "frames";
      maxFrames: number;
      timestampsSeconds?: number[];
    };

const ORIGINAL_DOCUMENT_MIMES = new Set([
  "application/pdf",
  "application/json",
  "text/csv",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

export function planMediaRepresentation(
  asset: MediaAsset,
  input: GetMediaInput,
): MediaRepresentationPlan {
  const mode = input.timestamps_seconds?.length ? "frames" : input.mode;
  if (mode === "original") return { kind: "original" };
  if (mode === "preview") {
    if (asset.descriptor.type === "photo" || asset.descriptor.mime_type?.startsWith("image/")) {
      return { kind: "image", source: "auto" };
    }
    if (asset.descriptor.has_thumbnail) return { kind: "image", source: "thumbnail" };
    throw mediaError("UNSUPPORTED_MEDIA", "No image preview is available", false);
  }
  if (mode === "frames") {
    if (!["video", "gif", "video_note"].includes(asset.descriptor.type)) {
      throw mediaError("UNSUPPORTED_MEDIA", "Frames require video media", false);
    }
    return {
      kind: "contact_sheet",
      mode: "frames",
      maxFrames: input.max_frames,
      ...(input.timestamps_seconds?.length
        ? { timestampsSeconds: [...input.timestamps_seconds].sort((a, b) => a - b) }
        : {}),
    };
  }
  switch (asset.descriptor.type) {
    case "photo":
      return { kind: "image", source: "auto" };
    case "video":
    case "gif":
    case "video_note":
      return { kind: "contact_sheet", mode: "auto", maxFrames: input.max_frames };
    case "voice":
    case "audio":
      return { kind: "original" };
    case "sticker":
      if (asset.descriptor.mime_type?.startsWith("image/")) {
        return { kind: "image", source: "auto" };
      }
      return asset.descriptor.has_thumbnail
        ? { kind: "image", source: "thumbnail" }
        : { kind: "original" };
    case "document": {
      const mime = asset.descriptor.mime_type ?? "";
      if (mime.startsWith("image/")) return { kind: "image", source: "auto" };
      if (mime.startsWith("text/") || ORIGINAL_DOCUMENT_MIMES.has(mime)) {
        return { kind: "original" };
      }
      return asset.descriptor.has_thumbnail
        ? { kind: "image", source: "thumbnail" }
        : { kind: "original" };
    }
    default:
      throw mediaError("UNSUPPORTED_MEDIA", "No downloadable media representation is available", false);
  }
}
```

- [ ] **Step 4: Run the planner tests**

Run: `npx vitest run tests/media-representation.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing version-2 token tests**

Extend `tests/media-token.test.ts` with one test per representation kind, exact key checks, and legacy verification:

```ts
const v2Claims: MediaCapabilityClaims = {
  v: 2,
  purpose: "telegram-media",
  sourceId: "-1001",
  messageId: 7,
  ownerId: "owner-1",
  representation: {
    kind: "contact_sheet",
    mode: "auto",
    maxFrames: 8,
  },
};

it("round-trips one strict version-2 representation capability", async () => {
  const now = new Date("2026-09-01T12:00:00Z");
  const issued = await issueMediaCapability(v2Claims, now, KEY);
  const { payload } = await jwtDecrypt(issued.token, KEY, { currentDate: now });
  expect(Object.keys(payload).sort()).toEqual([
    "exp", "iat", "messageId", "ownerId", "purpose",
    "representation", "sourceId", "v",
  ]);
  await expect(verifyMediaCapability(issued.token, now, KEY)).resolves.toEqual(v2Claims);
});

it("continues to verify an unexpired version-1 original capability", async () => {
  const now = new Date("2026-09-01T12:00:00Z");
  const issued = await issueMediaToken(claims, now, KEY);
  await expect(verifyMediaCapability(issued.token, now, KEY)).resolves.toEqual(claims);
});
```

Also craft encrypted v2 payloads with an extra representation key, `maxFrames: 11`, wrong purpose, wrong version, and a 601-second lifetime; each must reject with the same `AUTH_REQUIRED` error.

- [ ] **Step 6: Run token tests and verify the red state**

Run: `npx vitest run tests/media-token.test.ts`

Expected: FAIL because v2 capability exports do not exist.

- [ ] **Step 7: Implement the strict capability union**

In `src/media/token.ts`, preserve `issueMediaToken` for legacy test/source compatibility and add:

```ts
const representationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("original") }).strict(),
  z.object({
    kind: z.literal("image"),
    source: z.enum(["auto", "thumbnail"]),
  }).strict(),
  z.object({
    kind: z.literal("contact_sheet"),
    mode: z.enum(["auto", "frames"]),
    maxFrames: z.number().int().min(1).max(10),
    timestampsSeconds: z.array(z.number().finite().nonnegative()).max(10).optional(),
  }).strict(),
]);

const mediaCapabilityClaimsSchema = z.object({
  v: z.literal(2),
  purpose: z.literal("telegram-media"),
  sourceId: z.string().min(1),
  messageId: z.number().int().positive(),
  ownerId: z.string().min(1),
  representation: representationSchema,
}).strict();

export type MediaCapabilityClaims = z.infer<typeof mediaCapabilityClaimsSchema>;
export type VerifiedMediaCapability = MediaTokenClaims | MediaCapabilityClaims;
```

Factor encryption into one private helper so both issuers set `typ: "JWT"`, `iat`, `exp`, and the exact ten-minute lifetime. `verifyMediaCapability` must decrypt once, select schema only by `v`, reject unknown versions and extra keys, and return a safe generic error. Keep `verifyMediaToken` restricted to legacy v1 callers until Task 2 migrates the original route.

- [ ] **Step 8: Run Task 1 tests and the fast regression suite**

Run: `npx vitest run tests/media-representation.test.ts tests/media-token.test.ts`

Expected: PASS.

Run: `npm test`

Expected: all non-live tests PASS.

- [ ] **Step 9: Commit Task 1**

```bash
git add src/media/representation.ts src/media/token.ts tests/media-representation.test.ts tests/media-token.test.ts
git commit -m "feat: add media representation capabilities"
```

---

### Task 2: Heavy view materialization and route isolation

**Files:**
- Create: `src/media/materializer.ts`
- Create: `src/media/view-route.ts`
- Create: `app/api/media/view/[token]/route.ts`
- Create: `tests/media-view-route.test.ts`
- Modify: `src/media/original-route.ts`
- Modify: `tests/media-original-route.test.ts`
- Modify: `next.config.ts`
- Modify: `tests/media-service.test.ts`

**Interfaces:**
- Consumes: `MediaRepresentationPlan`, `verifyMediaCapability`, `resolveMediaAsset`, `readAssetBytes`, `readAssetThumbnail`, `downloadAssetToFile`, `normalizeImage`, `MediaProcessor`, `DerivativeCache`, and `contentDispositionAttachment`.
- Produces: `GeneratedMediaView`, `materializeMediaView(client, asset, plan, deps?)`, `ViewRouteDependencies`, and `handleViewRequest(request, token, overrides?)`.

- [ ] **Step 1: Write failing view-route tests**

Create `tests/media-view-route.test.ts`. Inject a verified v2 claim and fake Telegram client, then assert an image response and a contact-sheet response:

```ts
it("materializes a normalized image only after the view link is opened", async () => {
  const deps = fakeViewDeps({
    claims: {
      ...baseClaims,
      representation: { kind: "image", source: "auto" },
    },
    generated: {
      data: Buffer.from("jpeg"),
      mimeType: "image/jpeg",
      width: 1200,
      height: 800,
    },
  });
  const response = await handleViewRequest(
    new Request("https://gramscope.test/api/media/view/token"),
    "token",
    deps,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/jpeg");
  expect(response.headers.get("content-length")).toBe("4");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("accept-ranges")).toBeNull();
  expect(await response.text()).toBe("jpeg");
  expect(deps.resolveAsset).toHaveBeenCalledOnce();
});
```

Add exact cases for wrong owner `401`, legacy token `401`, v2 `original` token `401`, missing media `404`, oversized image `422`, processing timeout `504`, Telegram failure `502`, Range ignored with status `200`, thumbnail fallback for an automatic contact sheet, cache hit, single-flight, and temporary-file cleanup.

- [ ] **Step 2: Run the new route suite and verify the red state**

Run: `npx vitest run tests/media-view-route.test.ts`

Expected: FAIL because the view modules do not exist.

- [ ] **Step 3: Move materialization out of `service.ts`**

Create `src/media/materializer.ts` and move, without semantic relaxation, the current heavy functions and constants from `src/media/service.ts`:

```ts
export const AUTO_VIDEO_MAX_BYTES = 64 * 1024 * 1024;
export const AUTO_VIDEO_DEADLINE_MS = 25_000;
export const FRAMES_VIDEO_MAX_BYTES = 128 * 1024 * 1024;
export const FRAMES_VIDEO_DEADLINE_MS = 45_000;
export const FALLBACK_IMAGE_DEADLINE_MS = 5_000;

export type GeneratedMediaView = {
  data: Buffer;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
  frameCount?: number;
  timestampsSeconds?: number[];
};

export async function materializeMediaView(
  client: TelegramLike,
  asset: MediaAsset,
  plan: Exclude<MediaRepresentationPlan, { kind: "original" }>,
  overrides: Partial<MaterializerDependencies> = {},
): Promise<GeneratedMediaView> {
  const deps = { ...productionMaterializerDependencies, ...overrides };
  if (plan.kind === "image") {
    return materializeImageView(client, asset, plan, deps);
  }
  return materializeContactSheetView(client, asset, plan, deps);
}

async function materializeImageView(
  client: TelegramLike,
  asset: MediaAsset,
  plan: Extract<MediaRepresentationPlan, { kind: "image" }>,
  deps: MaterializerDependencies,
): Promise<GeneratedMediaView> {
  const thumbnail = await deps.readThumbnail(client, asset, INLINE_MEDIA_MAX_BYTES);
  if (plan.source === "thumbnail" && !thumbnail) {
    throw mediaError("UNSUPPORTED_MEDIA", "No image preview is available", false);
  }
  const data = thumbnail?.data ?? await deps.readBytes(
    client,
    asset,
    INLINE_MEDIA_MAX_BYTES,
  );
  return deps.normalizeImage(data, {
    preserveTransparency: asset.descriptor.mime_type === "image/png" ||
      asset.descriptor.mime_type === "image/webp",
    sourceMimeType: thumbnail?.mimeType ?? asset.descriptor.mime_type,
    maxBytes: INLINE_MEDIA_MAX_BYTES,
    maxLongEdge: 1600,
  });
}

async function materializeContactSheetView(
  client: TelegramLike,
  asset: MediaAsset,
  plan: Extract<MediaRepresentationPlan, { kind: "contact_sheet" }>,
  deps: MaterializerDependencies,
): Promise<GeneratedMediaView> {
  const maxBytes = plan.mode === "frames" ? FRAMES_VIDEO_MAX_BYTES : AUTO_VIDEO_MAX_BYTES;
  const deadlineMs = plan.mode === "frames" ? FRAMES_VIDEO_DEADLINE_MS : AUTO_VIDEO_DEADLINE_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  timer.unref?.();
  try {
    const key = derivativeKey({
      mediaId: asset.descriptor.media_id,
      mode: plan.mode,
      timestampsSeconds: plan.timestampsSeconds,
      maxFrames: plan.maxFrames,
      processorVersion: "contact-sheet-v1",
    });
    return await derivativeResult(key, () => generateVideoDerivative(
      client,
      asset,
      plan,
      deps,
      maxBytes,
      deadlineMs,
      controller.signal,
    ), deps, true, controller.signal);
  } catch (error) {
    if (plan.mode === "auto" && error instanceof GramScopeError) {
      const fallbackDeadline = AbortSignal.timeout(FALLBACK_IMAGE_DEADLINE_MS);
      const thumbnail = await deps.readThumbnail(
        client,
        asset,
        INLINE_MEDIA_MAX_BYTES,
        fallbackDeadline,
      );
      if (thumbnail) {
        return deps.normalizeImage(thumbnail.data, {
          sourceMimeType: thumbnail.mimeType,
          maxBytes: INLINE_MEDIA_MAX_BYTES,
          maxLongEdge: 1600,
          deadline: fallbackDeadline,
        });
      }
    }
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
```

Define `MaterializerDependencies` with the current service's exact injected
operations (`readBytes`, `readThumbnail`, `normalizeImage`, `downloadToFile`,
`probeDuration`, `contactSheet`, cache, derivative path/write/remove). Move the
complete existing bodies of `generateVideoDerivative`, `derivativeResult`, and
`readCachedDerivative` from `src/media/service.ts:347-665` into this file and
change their input from `GetMediaInput` to the exact `MediaRepresentationPlan`
fields shown above. Change error wording from “inline limit” to “generated
representation limit”, while retaining the stable legacy code
`INLINE_LIMIT_EXCEEDED`. Cached derivatives may be read into memory because the
HTTP output is capped at 2 MiB; no bytes return to MCP.

Move the derivative/cache tests at `tests/media-service.test.ts:612-1008` and normalized-image fallback tests at `tests/media-service.test.ts:1262-1306` into `tests/media-view-route.test.ts`, updating their calls to `materializeMediaView`. Do not delete coverage.

- [ ] **Step 4: Implement safe view HTTP delivery**

Create `src/media/view-route.ts` with the same complete-dependency injection pattern as `original-route.ts`:

```ts
export async function handleViewRequest(
  request: Request,
  token: string,
  overrides: Partial<ViewRouteDependencies> = {},
): Promise<Response> {
  const deps = completeViewDependencies(overrides)
    ? overrides
    : { ...productionViewDependencies(), ...overrides };
  try {
    const claims = await deps.verifyToken(token);
    if (claims.v !== 2 || claims.ownerId !== deps.ownerId || claims.representation.kind === "original") {
      return new Response("Unauthorized", { status: 401 });
    }
    return deps.withClient(async (client) => {
      const media = await deps.resolveAsset(client, {
        sourceId: claims.sourceId,
        messageId: claims.messageId,
      });
      const generated = await deps.materialize(client, media, claims.representation);
      const filename = safeMediaFilename({
        kind: generated.mimeType === "image/jpeg" ? "photo" : media.descriptor.type,
        messageId: media.messageId,
        mimeType: generated.mimeType,
      });
      return new Response(generated.data, {
        status: 200,
        headers: {
          "content-type": generated.mimeType,
          "content-length": String(generated.data.length),
          "content-disposition": contentDispositionAttachment(filename),
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
        },
      });
    });
  } catch (error) {
    return sanitizedViewError(error);
  }
}
```

`sanitizedViewError` must map token/owner failures to `401`, `MEDIA_NOT_FOUND`/`NO_MEDIA` to `404`, `INLINE_LIMIT_EXCEEDED`/`UNSUPPORTED_MEDIA` to `422`, `PROCESSING_TIMEOUT` to `504`, and Telegram/unknown retrieval failures to `502`. Responses contain generic fixed strings only.

- [ ] **Step 5: Add the thin Next route and isolate tracing**

Create `app/api/media/view/[token]/route.ts`:

```ts
import { handleViewRequest } from "@/media/view-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  return handleViewRequest(request, (await context.params).token);
}
```

In `next.config.ts`, change the route-specific include key from `/api/mcp` to the escaped dynamic view route key and keep patterns narrow:

```ts
outputFileTracingIncludes: {
  "/api/media/view/\\[token\\]": [
    "./node_modules/ffmpeg-static/ffmpeg",
    "./src/media/contact-sheet-worker.mjs",
  ],
},
```

This follows the official Next.js rule that keys match route globs and values resolve from the project root: <https://nextjs.org/docs/15/app/api-reference/config/next-config-js/output>.

- [ ] **Step 6: Accept only original claims in the original route**

Change `OriginalRouteDependencies.verifyToken` to return `VerifiedMediaCapability`. After owner validation, accept legacy v1 or v2 with `representation.kind === "original"`; return `401` for every view representation before resolving Telegram. Add tests proving v1 and v2 originals stream and a v2 image/contact-sheet token does not call `resolveAsset`.

- [ ] **Step 7: Run Task 2 tests and regression checks**

Run: `npx vitest run tests/media-view-route.test.ts tests/media-original-route.test.ts tests/media-service.test.ts tests/media-cache.test.ts tests/media-image.test.ts tests/media-processor.test.ts`

Expected: PASS.

Run: `npm run typecheck && npm run lint`

Expected: both PASS.

- [ ] **Step 8: Commit Task 2**

```bash
git add src/media/materializer.ts src/media/view-route.ts src/media/original-route.ts app/api/media/view/'[token]'/route.ts next.config.ts tests/media-view-route.test.ts tests/media-original-route.test.ts tests/media-service.test.ts
git commit -m "feat: add capability-linked media views"
```

---

### Task 3: Link-only MCP planner and compact result contract

**Files:**
- Modify: `src/media/service.ts`
- Modify: `src/mcp/media-result.ts`
- Modify: `src/mcp/tools/get-media.ts`
- Modify: `src/schemas/media.ts`
- Modify: `tests/media-service.test.ts`
- Modify: `tests/logging.test.ts`
- Modify: `tests/tools.test.ts`
- Modify: `tests/live/media.live.test.ts`

**Interfaces:**
- Consumes: `planMediaRepresentation`, `issueMediaCapability`, `resolveMediaAsset`, configuration origin/owner/secret, and `safeMediaFilename`.
- Produces: lightweight `MediaOutcome`, `getMedia(input, overrides?)`, and a `ToolResult` containing text plus exactly one link for `ready`/`fallback`.

- [ ] **Step 1: Replace direct-content expectations with failing link-only tests**

In `tests/media-service.test.ts`, replace the current direct-artifact contract cases with:

```ts
it.each([
  ["photo", "image/jpeg", "/api/media/view/"],
  ["video", "video/mp4", "/api/media/view/"],
  ["voice", "audio/ogg", "/api/media/"],
  ["document", "application/pdf", "/api/media/"],
] as const)("returns one compact link for %s without reading bytes", async (type, mime, path) => {
  const deps = fakePlannerDeps({ asset: fakeAsset({ type, mime_type: mime }) });
  const outcome = await getMedia(input(), deps);
  const tool = mediaToolResult(outcome);
  expect(tool.content.map((part) => part.type)).toEqual(["text", "resource_link"]);
  expect(JSON.stringify(tool)).not.toMatch(/"data"\s*:/);
  expect(JSON.stringify(tool).length).toBeLessThan(32 * 1024);
  expect((tool.content[1] as { uri: string }).uri).toContain(path);
  expect(deps.readBytes).not.toHaveBeenCalled();
  expect(deps.readThumbnail).not.toHaveBeenCalled();
  expect(deps.downloadToFile).not.toHaveBeenCalled();
});

it("does not attach a resource link to a planning error", async () => {
  const outcome = await getMedia(input({ mode: "frames" }), fakePlannerDeps({
    asset: fakeAsset({ type: "voice", mime_type: "audio/ogg" }),
  }));
  expect(mediaToolResult(outcome).content.map((part) => part.type)).toEqual(["text"]);
  expect(outcome.result).toMatchObject({ status: "error", code: "UNSUPPORTED_MEDIA" });
});
```

Add a test that a bounded voice result has one link and zero audio blocks, reproducing the exact regression that previously emitted both. Add an assertion that repeated serialization of photo, video, and voice tool results totals below 96 KiB.

- [ ] **Step 2: Run service tests and verify the red state**

Run: `npx vitest run tests/media-service.test.ts`

Expected: FAIL because current `getMedia` downloads and returns artifacts.

- [ ] **Step 3: Rewrite `service.ts` as a lightweight planner**

Remove every import of `node:fs`, `node:os`, `node:path`, `image`, `ffmpeg-processor`, `cache`, and Telegram byte readers. Use only these dependencies:

```ts
export type MediaLink = {
  uri: string;
  name: string;
  mimeType?: string;
  size?: number;
};

export type MediaOutcome = {
  result: GetMediaResult;
  link?: MediaLink;
};

export type MediaDependencies = {
  withClient<T>(run: (client: TelegramLike) => Promise<T>): Promise<T>;
  resolveAsset(client: TelegramLike, input: {
    sourceId: string;
    messageId: number;
  }): Promise<MediaAsset>;
  issueCapability(
    claims: MediaCapabilityClaims,
  ): Promise<{ token: string; expiresAt: Date }>;
  mediaOrigin: string;
  ownerId: string;
};
```

Implement `getMedia` as resolve → plan → issue → result. Use `/api/media/{token}` for `original` and `/api/media/view/{token}` otherwise. Set `representation.delivery` to `resource_link`; map `original` kind to `audio`, `document`, `image`, or `download` from media metadata, and view plans to `image`. Keep `download.url` equal to the resource-link URI for 1.5.0 schema compatibility. Do not catch expected planner errors inside the service unless converting them to the existing stable `error` envelope.

- [ ] **Step 4: Make the result builder structurally incapable of binary output**

Replace `src/mcp/media-result.ts` with link-only construction:

```ts
export function mediaToolResult(outcome: MediaOutcome): ToolResult {
  const content: ToolResult["content"] = [{
    type: "text",
    text: `${outcome.result.status}: ${outcome.result.representation?.kind ?? "metadata"}`,
  }];
  if (outcome.link) content.push({
    type: "resource_link",
    uri: outcome.link.uri,
    name: outcome.link.name,
    ...(outcome.link.mimeType ? { mimeType: outcome.link.mimeType } : {}),
    ...(outcome.link.size !== undefined ? { size: outcome.link.size } : {}),
  });
  return {
    content,
    structuredContent: outcome.result,
    ...(outcome.result.status === "error" ? { isError: true } : {}),
  };
}
```

There must be no `artifact` field in `MediaOutcome` and no code path capable of creating MCP `image` or `audio` parts.

- [ ] **Step 5: Update the public schema and model-facing description**

In `src/schemas/media.ts`, extend representation kinds with `document` and add `delivery: z.literal("resource_link").optional()`. Retain `INLINE_LIMIT_EXCEEDED` only for backward-compatible parsing.

In `src/mcp/tools/get-media.ts`, use this description:

```text
Retrieve media attached to one Telegram message when its contents may affect the answer. Pass source_id and message_id and normally omit mode. GramScope returns one short-lived resource link to the best representation. Open it once. Do not retry get_media automatically if file materialization is denied, fails, or the link expires.
```

Update `tests/tools.test.ts` to assert the description contains “one short-lived resource link” and “Do not retry”. Keep the twenty-tool and read-only assertions unchanged.

- [ ] **Step 6: Update live tests to materialize links explicitly**

In `tests/live/media.live.test.ts`, replace direct `artifact` assertions with URL-shape assertions and call the route handlers using the returned token. The photo/contact-sheet path must invoke `handleViewRequest`; voice/audio/original uses `handleOriginalRequest`. Assert `getMedia` itself performs only the message refetch and that HTTP opening returns non-empty content with the expected MIME.

- [ ] **Step 7: Run Task 3 tests and the full local gate**

Run: `npx vitest run tests/media-service.test.ts tests/logging.test.ts tests/tools.test.ts tests/mcp-handler.test.ts`

Expected: PASS.

Run: `npm test && npm run typecheck && npm run lint && npm run build`

Expected: all commands PASS; build lists `/api/mcp`, `/api/media/[token]`, and `/api/media/view/[token]`.

- [ ] **Step 8: Commit Task 3**

```bash
git add src/media/service.ts src/mcp/media-result.ts src/mcp/tools/get-media.ts src/schemas/media.ts tests/media-service.test.ts tests/logging.test.ts tests/tools.test.ts tests/live/media.live.test.ts
git commit -m "fix: return Telegram media as links only"
```

---

### Task 4: Bundle guard, documentation, deployment, and ChatGPT acceptance

**Files:**
- Create: `scripts/check-media-traces.mjs`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/chatgpt-project-instructions.md`
- Modify: `docs/media-chatgpt-acceptance.md`
- Modify: `docs/superpowers/tasks/issue-1-media.md`

**Interfaces:**
- Consumes: completed link-only routes, Next.js build trace files, live Telegram selectors, and the owner-run ordinary ChatGPT result.
- Produces: repeatable trace check, current user/model documentation, deployed measurements, and the final acceptance record for issue #1.

- [ ] **Step 1: Write the failing production-trace guard**

Create `scripts/check-media-traces.mjs`:

```js
import { readFile } from "node:fs/promises";

const readTrace = async (path) =>
  JSON.parse(await readFile(path, "utf8")).files.map((file) => file.replaceAll("\\", "/"));

const mcp = await readTrace(".next/server/app/api/mcp/route.js.nft.json");
const view = await readTrace(".next/server/app/api/media/view/[token]/route.js.nft.json");
const isFfmpeg = (file) => file.includes("ffmpeg-static") || file.endsWith("contact-sheet-worker.mjs");

if (mcp.some(isFfmpeg)) {
  throw new Error("MCP trace must not contain FFmpeg assets");
}
if (!view.some(isFfmpeg)) {
  throw new Error("View trace must contain FFmpeg assets");
}
process.stdout.write("Media trace boundary verified\n");
```

Add `"check:media-traces": "node scripts/check-media-traces.mjs"` to `package.json`.

- [ ] **Step 2: Build and run the guard**

Run: `npm run build && npm run check:media-traces`

Expected: PASS with `Media trace boundary verified`. If Next emits a different literal trace filename, inspect `.next/server/app/api/media/view` and update only the two exact paths in the script; do not weaken the assertions or use broad recursive discovery.

- [ ] **Step 3: Update user and model documentation**

In `README.md`, replace all direct/bounded-inline wording with:

```markdown
`get_media(source_id, message_id, mode?)` returns one short-lived link to the
best model-friendly representation. Photos and images become image links;
videos, GIFs, and video notes become one labelled JPEG contact sheet; voice and
audio link to the exact source bytes; documents use a supported original or a
thumbnail/original fallback. The MCP result never contains media bytes or
base64, so media does not consume the conversation transcript.
```

Document that the user may see one ChatGPT file-materialization approval and that denial/expiry requires an explicit user retry, not an automatic loop. Explain the separate lightweight original and heavy view routes, ten-minute expiry, no transcription, temporary derivative cache, and Range only for originals.

In `docs/chatgpt-project-instructions.md`, replace “bounded image/audio representation” with “one short-lived resource link”, tell the model to open it once, and prohibit automatic repeated `get_media` calls after denial/fetch failure/expiry.

- [ ] **Step 4: Update the acceptance journal before deployment**

In `docs/media-chatgpt-acceptance.md`, preserve historical inline evidence and add a dated “Link-only replacement gate” section recording:

- zero direct `image`/`audio` parts;
- one `resource_link` per successful photo/video/voice call;
- individual and aggregate serialized MCP byte counts;
- `/api/mcp` and `/api/media/view` build/deployment bundle sizes;
- photo, contact-sheet, and voice HTTP status/MIME/length;
- cold/warm view latency;
- no automatic retry after a rejected materialization;
- ordinary ChatGPT evidence still marked pending until the owner reports it.

- [ ] **Step 5: Run the complete local and live gates**

Run: `npm test && npm run typecheck && npm run lint && npm run build && npm run check:media-traces`

Expected: all PASS.

Run without selectors: `npm run test:live`

Expected: all live tests SKIP and no Telegram connection occurs.

Run with the deliberately configured media selectors: `GRAMSCOPE_LIVE=1 npm run test:live`

Expected: every configured media case PASS; missing sticker remains an explicit skip unless a deliberate sticker selector has been added.

- [ ] **Step 6: Commit the bundle guard and documentation**

```bash
git add scripts/check-media-traces.mjs package.json README.md docs/chatgpt-project-instructions.md docs/media-chatgpt-acceptance.md docs/superpowers/tasks/issue-1-media.md
git commit -m "docs: document link-only media delivery"
```

- [ ] **Step 7: Deploy and run non-ChatGPT production acceptance**

Deploy the current `main` using the repository's established Vercel workflow. Record the Ready deployment identifier and measured function sizes. Invoke `get_media` for the deliberate photo, video, and voice selectors; verify the MCP responses contain only `text` plus one `resource_link`, each is below 32 KiB, and their total is below 96 KiB. Open each returned capability once and record status, MIME, exact bytes, and cold/warm latency without storing the signed URL or private filename.

Inspect raw deployment logs using the existing acceptance procedure. Assert they contain none of the exact capability, source/message selector, filename, media fingerprint, `file_reference`, or `access_hash` values.

- [ ] **Step 8: Hand off the ordinary ChatGPT gate to the owner**

Ask the owner to reconnect/refresh GramScope in one fresh ordinary ChatGPT Project chat and run the three existing photo/video/voice prompts from `docs/media-chatgpt-acceptance.md`. Required evidence:

```text
photo: one get_media call, one materialization approval at most, model uses image
video: one get_media call, one materialization approval at most, model uses contact sheet
voice: one get_media call, one materialization approval at most, model receives usable audio
after all three: conversation remains usable and no get_media retry loop occurred
```

Do not claim this gate passed until the owner supplies the actual client result.

- [ ] **Step 9: Record final evidence and close the amendment**

After the owner reports success, append the dated result to `docs/media-chatgpt-acceptance.md`, check the 2026-09-01 link-only open question in `docs/superpowers/tasks/issue-1-media.md`, run `git diff --check`, and commit:

```bash
git add docs/media-chatgpt-acceptance.md docs/superpowers/tasks/issue-1-media.md
git commit -m "docs: accept link-only media in ChatGPT"
```

Push `main` only after all automated, deployed, log-redaction, and ordinary-ChatGPT gates are recorded. Issue #1 may close only when no other open question in its task card remains.

---

## Self-Review Record

- Spec coverage: every amended requirement in §§1–20 maps to Tasks 1–4; existing metadata, security, Range, cache, live, and deployment coverage is preserved rather than deleted.
- Boundary check: only `src/media/materializer.ts` and `src/media/view-route.ts` import Sharp/FFmpeg-backed modules; `src/media/service.ts` is byte-free and safe for `/api/mcp`.
- Type consistency: `MediaRepresentationPlan` is used unchanged by tokens, planner, materializer, and route handlers; v1/v2 token return types are explicit.
- Failure contract: planning errors return compact MCP error envelopes with no link; post-link failures return fixed sanitized HTTP statuses; retry loops are prohibited in tool/model instructions.
- Red-flag scan: every code action names exact functions, values, tests, commands, and expected outcomes; no deferred implementation markers remain.
