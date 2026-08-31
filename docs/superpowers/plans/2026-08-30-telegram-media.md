# GramScope Telegram Media Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an ordinary ChatGPT Project chat inspect Telegram photos, videos, GIFs, video notes, voice notes, audio, stickers, and document thumbnails through one bounded `get_media` call, while streaming large originals securely.

**Architecture:** Existing message tools add download-free media metadata. One read-only `get_media` tool refetches the raw Telegram message, selects a deterministic representation, and returns at most one direct MCP image/audio artifact; generated video contact sheets use bounded temporary files and a warm derivative cache. Large originals use a ten-minute encrypted capability and a separate chunked HTTP route with Range support.

**Tech Stack:** TypeScript, Next.js 15 on Vercel, `@modelcontextprotocol/server` 2, `mcp-handler` 2, teleproto 1.229, zod 4, jose 5, sharp, ffmpeg-static, vitest.

**Spec:** `docs/superpowers/specs/2026-08-30-telegram-media-design.md`

## Global Constraints

- Work directly on branch `main`; preserve unrelated user changes and never create a worktree unless the owner changes the repository-wide decision.
- All code, comments, commit messages, and repository docs are English; address the owner in Russian.
- Target version is **1.5.0** in `package.json`, `package-lock.json`, and `src/mcp/version.ts`.
- Exactly **twenty MCP tools** after the release; `get_media` is read-only.
- `(source_id, message_id)` is the only public retrieval selector. `media_id` is identity/cache metadata and is never accepted as input.
- Existing discovery, search, message, thread, and pinned-message tools remain download-free and within their existing 256 KiB structured-response budget.
- Direct binary content is at most **2 MiB raw**, with at most one direct image/audio artifact per call.
- Default video contact sheet has 8 frames; hard maximum 10.
- `auto` video budget: 64 MiB and a 25-second derivative deadline. Explicit `frames`: 128 MiB and 45 seconds. The deadline includes Telegram download, probe, decode, labelling, and encoding.
- Generated derivative cache only: 30-minute TTL and 256 MiB LRU ceiling. Never cache originals, signed URLs, Telegram locations, `file_reference`, or `access_hash`.
- Original capability lifetime is 10 minutes. Tokens are encrypted/authenticated and contain no Telegram capability data.
- Voice/audio preserves source bytes, encoding, MIME, size, and a stable safe filename. No server transcription or original transcoding.
- Run focused tests red/green for every step. Before each commit run `npm test`, `npm run typecheck`, and `npm run lint`; run `npm run build` for route/dependency tasks and `npm run test:live` only in Task 7.
- After changing tool schemas, refresh/reconnect the ChatGPT app before acceptance because ChatGPT caches the tool list.

---

## File Structure

Created:

- `src/schemas/media.ts` — public media descriptors, `get_media` input/output schemas, modes, codes, and byte/frame constants.
- `src/telegram/media.ts` — raw-message refetch, internal `MediaAsset`, thumbnail selection, and the only media-facing wrapper around `TelegramLike.iterDownload`.
- `src/media/service.ts` — deterministic `auto` orchestration and `MediaOutcome` production.
- `src/media/names.ts` — MIME extension mapping and safe stable filenames.
- `src/media/image.ts` — bounded photo/thumbnail normalization with sharp.
- `src/media/token.ts` — ten-minute compact JWE creation and validation.
- `src/media/range.ts` — single HTTP byte-range parsing.
- `src/media/original-route.ts` — authenticated-token validation and chunked original response.
- `src/media/processor.ts` — processor contract and normalized contact-sheet request/result.
- `src/media/ffmpeg-processor.ts` — one-process frame extraction and sharp contact-sheet assembly.
- `src/media/cache.ts` — byte-bounded derivative LRU/TTL, single-flight, and one-slot video gate.
- `src/mcp/media-result.ts` — rich MCP text/image/audio/resource-link result builder with no binary duplication.
- `src/mcp/tools/get-media.ts` — the twentieth tool registration.
- `app/api/media/[token]/route.ts` — thin Next route wrapper around `handleOriginalRequest`.
- `tests/media-service.test.ts`, `tests/media-image.test.ts`, `tests/media-token.test.ts`, `tests/media-original-route.test.ts`, `tests/media-processor.test.ts`, `tests/media-cache.test.ts` — fast unit/integration coverage.
- `tests/live/media.live.test.ts` — real Telegram retrieval and streaming acceptance.
- `docs/media-chatgpt-acceptance.md` — dated evidence from the ordinary ChatGPT Project-chat compatibility gate.

Modified:

- `src/schemas/message.ts`, `src/telegram/client.ts`,
  `src/telegram/message-slice.ts`, `src/errors/taxonomy.ts`, `src/config.ts`,
  `src/mcp/tool-result.ts`, `src/mcp/logging.ts`, `src/mcp/server.ts`,
  `src/mcp/version.ts`.
- `tests/schemas-message.test.ts`, `tests/telegram-client.test.ts`,
  `tests/telegram-message-slice.test.ts`, `tests/telegram-messages.test.ts`,
  `tests/telegram-search.test.ts`, `tests/telegram-thread.test.ts`,
  `tests/telegram-pinned.test.ts`, `tests/errors.test.ts`,
  `tests/logging.test.ts`, `tests/tools.test.ts`,
  `tests/mcp-handler.test.ts`, `tests/tool-names.ts`, `tests/config.test.ts`.
- `next.config.ts`, `.env.example`, `scripts/provision.sh`, `README.md`,
  `docs/chatgpt-project-instructions.md`,
  `docs/superpowers/tasks/issue-1-media.md`, `package.json`,
  `package-lock.json`.

The issue spans transport, media processing, and deployment, but they are not independent sub-projects: all depend on the same `get_media` contract and must ship together. Keep one plan with seven reviewer-gated tasks, matching the approved delivery decomposition.

---

### Task 1: ChatGPT vertical slice — rich tool results, photo, and voice

**Files:**

- Create: `src/schemas/media.ts`
- Create: `src/telegram/media.ts`
- Create: `src/media/service.ts`
- Create: `src/mcp/media-result.ts`
- Create: `src/mcp/tools/get-media.ts`
- Create: `tests/media-service.test.ts`
- Modify: `src/telegram/client.ts`
- Modify: `src/errors/taxonomy.ts`
- Modify: `src/mcp/tool-result.ts`
- Modify: `src/mcp/logging.ts`
- Modify: `src/mcp/server.ts`
- Modify: `tests/telegram-client.test.ts`
- Modify: `tests/logging.test.ts`
- Modify: `tests/tools.test.ts`
- Modify: `tests/mcp-handler.test.ts`
- Modify: `tests/tool-names.ts`

**Interfaces:**

- Consumes: `fetchDialogIndex({ includeFolders: false })` followed by
  `resolveSource(client, index, sourceId)` from `src/telegram/peer-resolve.ts`;
  `withTelegram`; teleproto `iterDownload(message, { offset, limit,
  requestSize })` through `TelegramLike` only.
- Produces:

```ts
export const INLINE_MEDIA_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_FRAMES = 8;
export const MAX_FRAMES = 10;

export function mediaId(
  sourceId: string,
  messageId: number,
  kind: string,
  rawId: string,
): string;

export type MediaDescriptor = {
  media_id: string;
  type: string;
  file_name?: string;
  mime_type?: string;
  size?: number;
  width?: number;
  height?: number;
  duration_seconds?: number;
  has_thumbnail?: boolean;
};

export type MediaAsset = {
  sourceId: string;
  messageId: number;
  sourceHandle: string;
  descriptor: MediaDescriptor;
  rawMessage: Record<string, unknown>;
  rawMedia: Record<string, unknown>;
  thumbnailLocation?: unknown;
};

export type MediaArtifact = {
  type: "image" | "audio";
  data: Buffer;
  mimeType: string;
};

export type MediaOutcome = {
  result: GetMediaResult;
  artifact?: MediaArtifact;
  link?: { uri: string; name: string; mimeType?: string; size?: number };
};

export type GetMediaResult = {
  status: "ready" | "fallback" | "error";
  source_id: string;
  message_id: number;
  media?: MediaDescriptor;
  representation?: {
    kind: "image" | "audio" | "download" | "metadata";
    mime_type?: string;
    file_name?: string;
    byte_size?: number;
    width?: number;
    height?: number;
    frame_count?: number;
    timestamps_seconds?: number[];
  };
  download?: { url: string; expires_at: string };
  code?: MediaResultCode;
  retryable?: boolean;
  message?: string;
};

export type MediaDependencies = {
  withClient<T>(run: (client: TelegramLike) => Promise<T>): Promise<T>;
  resolveAsset(client: TelegramLike, input: { sourceId: string; messageId: number }): Promise<MediaAsset>;
  readBytes(client: TelegramLike, asset: MediaAsset, limit: number, signal?: AbortSignal): Promise<Buffer>;
  readThumbnail?: (
    client: TelegramLike,
    asset: MediaAsset,
    limit: number,
    signal?: AbortSignal,
  ) => Promise<MediaArtifact | undefined>;
  normalizeImage?: (source: Buffer, options?: {
    preserveTransparency?: boolean;
    sourceMimeType?: string;
  }) => Promise<{
    data: Buffer; mimeType: "image/jpeg" | "image/png" | "image/webp"; width: number; height: number;
  }>;
  attachOriginalLink?: (asset: MediaAsset, outcome: MediaOutcome) => Promise<MediaOutcome>;
  downloadToFile?: (
    client: TelegramLike,
    asset: MediaAsset,
    options: { path: string; maxBytes: number; deadlineMs: number; signal?: AbortSignal },
  ) => Promise<number>;
  probeDuration?: (inputPath: string, deadline: AbortSignal) => Promise<number>;
  contactSheet?: (inputPath: string, request: {
    timestampsSeconds: number[];
    maxBytes: number;
    maxLongEdge: number;
    deadline: AbortSignal;
  }) => Promise<{
    data: Buffer;
    mimeType: "image/jpeg";
    width: number;
    height: number;
    frameCount: number;
    timestampsSeconds: number[];
  }>;
};

export async function resolveMediaAsset(
  client: TelegramLike,
  input: { sourceId: string; messageId: number },
): Promise<MediaAsset>;

export function iterAssetBytes(
  client: TelegramLike,
  asset: MediaAsset,
  options?: { file?: unknown; offset?: number; limit?: number; signal?: AbortSignal },
): AsyncIterable<Buffer>;

export async function getMedia(
  input: GetMediaInput,
  deps?: Partial<MediaDependencies>,
): Promise<MediaOutcome>;

export function mediaToolResult(outcome: MediaOutcome): ToolResult;
```

- Task 1 supports direct `photo` and `voice`/`audio` only when source bytes are already at most 2 MiB. Other media returns a safe `fallback` metadata result until later tasks extend the same switch.

- [ ] **Step 1: Write the failing schema and rich-result tests**

```ts
// tests/media-service.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  getMediaInputSchema,
  INLINE_MEDIA_MAX_BYTES,
} from "@/schemas/media";
import { mediaToolResult } from "@/mcp/media-result";

describe("get_media contract", () => {
  it("defaults to auto and eight frames", () => {
    expect(getMediaInputSchema.parse({ source_id: "@news", message_id: 7 }))
      .toMatchObject({ mode: "auto", max_frames: 8 });
  });

  it("rejects more than ten timestamps", () => {
    expect(() => getMediaInputSchema.parse({
      source_id: "@news",
      message_id: 7,
      timestamps_seconds: Array.from({ length: 11 }, (_, i) => i),
    })).toThrow();
  });

  it("keeps binary out of structuredContent", () => {
    const bytes = Buffer.from("image-bytes");
    const result = mediaToolResult({
      result: {
        status: "ready",
        source_id: "-1001",
        message_id: 7,
        representation: { kind: "image", mime_type: "image/jpeg", byte_size: bytes.length },
      },
      artifact: { type: "image", data: bytes, mimeType: "image/jpeg" },
    });
    expect(result.content.map((part) => part.type)).toEqual(["text", "image"]);
    expect(JSON.stringify(result.structuredContent)).not.toContain(bytes.toString("base64"));
    expect(bytes.length).toBeLessThan(INLINE_MEDIA_MAX_BYTES);
  });
});
```

- [ ] **Step 2: Run the focused test and verify red**

Run: `npx vitest run tests/media-service.test.ts`

Expected: FAIL because `@/schemas/media` and `@/mcp/media-result` do not exist.

- [ ] **Step 3: Add the media schemas and strict input refinement**

```ts
// src/schemas/media.ts
import { createHash } from "node:crypto";
import { z } from "zod";

export const INLINE_MEDIA_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_FRAMES = 8;
export const MAX_FRAMES = 10;
export const MEDIA_MODES = ["auto", "preview", "frames", "original"] as const;
export const MEDIA_RESULT_CODES = [
  "MEDIA_NOT_FOUND",
  "NO_MEDIA",
  "UNSUPPORTED_MEDIA",
  "INLINE_LIMIT_EXCEEDED",
  "PROCESSING_TIMEOUT",
  "TELEGRAM_DOWNLOAD_FAILED",
] as const;

export function mediaId(
  sourceId: string,
  messageId: number,
  kind: string,
  rawId: string,
): string {
  const canonical = ["v1", sourceId, String(messageId), kind, rawId].join("\0");
  return `med_${createHash("sha256").update(canonical).digest("base64url")}`;
}

export const mediaDescriptorSchema = z.object({
  media_id: z.string().startsWith("med_"),
  type: z.string(),
  file_name: z.string().optional(),
  mime_type: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  duration_seconds: z.number().nonnegative().optional(),
  has_thumbnail: z.boolean().optional(),
});

export const getMediaInputSchema = z.object({
  source_id: z.string().min(1),
  message_id: z.number().int().positive(),
  mode: z.enum(MEDIA_MODES).default("auto"),
  timestamps_seconds: z.array(z.number().finite().nonnegative()).max(MAX_FRAMES).optional(),
  max_frames: z.number().int().min(1).max(MAX_FRAMES).default(DEFAULT_MAX_FRAMES),
}).superRefine((value, ctx) => {
  if (value.mode === "original" && value.timestamps_seconds?.length) {
    ctx.addIssue({ code: "custom", path: ["timestamps_seconds"], message: "timestamps_seconds cannot be combined with mode=original" });
  }
});

export type GetMediaInput = z.infer<typeof getMediaInputSchema>;
export type MediaDescriptor = z.infer<typeof mediaDescriptorSchema>;
export type MediaResultCode = (typeof MEDIA_RESULT_CODES)[number];

export const mediaRepresentationSchema = z.object({
  kind: z.enum(["image", "audio", "download", "metadata"]),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
  byte_size: z.number().int().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  frame_count: z.number().int().min(1).max(MAX_FRAMES).optional(),
  timestamps_seconds: z.array(z.number().nonnegative()).max(MAX_FRAMES).optional(),
});

export const getMediaResultSchema = z.object({
  status: z.enum(["ready", "fallback", "error"]),
  source_id: z.string(),
  message_id: z.number().int().positive(),
  media: mediaDescriptorSchema.optional(),
  representation: mediaRepresentationSchema.optional(),
  download: z.object({ url: z.url(), expires_at: z.iso.datetime() }).optional(),
  code: z.enum(MEDIA_RESULT_CODES).optional(),
  retryable: z.boolean().optional(),
  message: z.string().optional(),
});

export type GetMediaResult = z.infer<typeof getMediaResultSchema>;
```

Append the six `MEDIA_RESULT_CODES` string literals to `ERROR_CODES` in
`src/errors/taxonomy.ts` in the same step, so the service never casts an
unregistered error code. Extend the error shape without breaking existing
three-argument calls:

```ts
export type StructuredError = {
  code: ErrorCode;
  message: string;
  retry_after_seconds?: number;
  retryable?: boolean;
};

export class GramScopeError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly retryAfterSeconds?: number,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "GramScopeError";
  }

  toStructured(): StructuredError {
    return {
      code: this.code,
      message: this.message,
      ...(this.retryAfterSeconds !== undefined
        ? { retry_after_seconds: this.retryAfterSeconds }
        : {}),
      ...(this.retryable ? { retryable: true } : {}),
    };
  }
}

export function mediaError(
  code: ErrorCode,
  message: string,
  retryable = false,
): GramScopeError {
  return new GramScopeError(code, message, undefined, retryable);
}
```

- [ ] **Step 4: Widen the common MCP result type and add the rich builder**

```ts
// src/mcp/tool-result.ts
import type { CallToolResult } from "@modelcontextprotocol/server";
export type ToolResult = CallToolResult & { structuredContent: unknown };
```

```ts
// src/mcp/media-result.ts
import type { MediaOutcome } from "../media/service";
import type { ToolResult } from "./tool-result";

export function mediaToolResult(outcome: MediaOutcome): ToolResult {
  const { result, artifact, link } = outcome;
  const content: ToolResult["content"] = [{
    type: "text",
    text: `${result.status}: ${result.representation?.kind ?? "metadata"}`,
  }];
  if (artifact) content.push({
    type: artifact.type,
    data: artifact.data.toString("base64"),
    mimeType: artifact.mimeType,
  });
  if (link) content.push({
    type: "resource_link",
    uri: link.uri,
    name: link.name,
    ...(link.mimeType ? { mimeType: link.mimeType } : {}),
    ...(link.size !== undefined ? { size: link.size } : {}),
  });
  return {
    content,
    structuredContent: result,
    ...(result.status === "error" ? { isError: true } : {}),
  };
}
```

- [ ] **Step 5: Run the schema/result test and verify green**

Run: `npx vitest run tests/media-service.test.ts tests/tools.test.ts`

Expected: PASS for the new cases; existing text-only result tests remain green.

- [ ] **Step 6: Write failing raw-message and bounded-download tests**

```ts
// append to tests/media-service.test.ts
function photoMessage(input: { id: number; bytes: number }) {
  return {
    className: "Message",
    id: input.id,
    media: {
      className: "MessageMediaPhoto",
      photo: { className: "Photo", id: 11n, sizes: [], dcId: 2 },
    },
    expectedBytes: input.bytes,
  };
}

function fakeAsset(overrides: Partial<MediaDescriptor> = {}): MediaAsset {
  const rawMessage = photoMessage({ id: 7, bytes: 5 });
  return {
    sourceId: "-1001",
    messageId: 7,
    sourceHandle: "@news",
    descriptor: {
      media_id: "med_test",
      type: "photo",
      mime_type: "image/jpeg",
      size: 5,
      ...overrides,
    },
    rawMessage,
    rawMedia: rawMessage.media,
  };
}

function fakeMediaClient(overrides: Partial<TelegramLike> = {}): TelegramLike {
  return {
    connected: true,
    connect: vi.fn(async () => true),
    invoke: vi.fn(async () => ({})),
    getDialogs: vi.fn(async () => []),
    getEntity: vi.fn(async () => ({
      className: "Channel",
      id: 1n,
      accessHash: 2n,
      title: "News",
      username: "news",
    })),
    getMessages: vi.fn(async () => []),
    iterDownload: vi.fn(async function* () {}),
    ...overrides,
  } as TelegramLike;
}

function input(overrides: Partial<GetMediaInput> = {}): GetMediaInput {
  return {
    source_id: "-1001",
    message_id: 7,
    mode: "auto",
    max_frames: 8,
    ...overrides,
  };
}

function fakeMediaDeps(options: {
  asset?: MediaAsset;
  bytes?: Buffer;
} = {}): MediaDependencies & {
  resolveAsset: ReturnType<typeof vi.fn>;
  readBytes: ReturnType<typeof vi.fn>;
} {
  const client = fakeMediaClient();
  return {
    withClient: async <T>(run: (value: TelegramLike) => Promise<T>) => run(client),
    resolveAsset: vi.fn(async () => options.asset ?? fakeAsset()),
    readBytes: vi.fn(async () => options.bytes ?? Buffer.from("abcde")),
  };
}

it("refetches by stable selector and joins download chunks", async () => {
  const calls: unknown[] = [];
  const client = fakeMediaClient({
    getMessages: async (_entity, params) => {
      calls.push(params);
      return [photoMessage({ id: 7, bytes: 5 })];
    },
    iterDownload: async function* () {
      yield Buffer.from("ab");
      yield Buffer.from("cde");
    },
  });
  const asset = await resolveMediaAsset(client, { sourceId: "@news", messageId: 7 });
  const chunks: Buffer[] = [];
  for await (const chunk of iterAssetBytes(client, asset, { limit: 5 })) chunks.push(chunk);
  expect(calls).toContainEqual({ ids: [7] });
  expect(Buffer.concat(chunks).toString()).toBe("abcde");
});

it("stops before yielding a byte beyond the inline limit", async () => {
  const asset = fakeAsset({ size: undefined });
  const client = fakeMediaClient({
    iterDownload: async function* () {
      yield Buffer.alloc(INLINE_MEDIA_MAX_BYTES);
      yield Buffer.from([1]);
    },
  });
  await expect(readAssetBytes(client, asset, INLINE_MEDIA_MAX_BYTES))
    .rejects.toMatchObject({ code: "INLINE_LIMIT_EXCEEDED" });
});
```

- [ ] **Step 7: Extend `TelegramLike` and implement the resolver/download wrapper**

```ts
// src/telegram/client.ts, inside TelegramLike
iterDownload(
  file: unknown,
  params?: { offset?: number; limit?: number; requestSize?: number },
): AsyncGenerator<Buffer, void, unknown>;
```

```ts
// src/telegram/media.ts
export async function resolveMediaAsset(client: TelegramLike, input: {
  sourceId: string;
  messageId: number;
}): Promise<MediaAsset> {
  const index = await fetchDialogIndex({ includeFolders: false });
  const source = await resolveSource(client, index, input.sourceId);
  const rows = Array.from(await client.getMessages(source.handle, { ids: [input.messageId] }));
  const rawMessage = rows[0] as Record<string, unknown> | undefined;
  if (!rawMessage || rawMessage.className === "MessageEmpty") {
    throw mediaError("MEDIA_NOT_FOUND", "The Telegram message no longer exists", false);
  }
  const rawMedia = rawMessage.media as Record<string, unknown> | undefined;
  if (!rawMedia) throw mediaError("NO_MEDIA", "The message has no downloadable media", false);
  return normalizeMediaAsset(source, rawMessage, rawMedia);
}

function normalizeMediaAsset(
  source: ResolvedSource,
  rawMessage: Record<string, unknown>,
  rawMedia: Record<string, unknown>,
): MediaAsset {
  const messageId = rawMessage.id;
  if (typeof messageId !== "number" || !Number.isInteger(messageId)) {
    throw mediaError("MEDIA_NOT_FOUND", "The Telegram message no longer exists", false);
  }
  const descriptor = mediaOf(rawMedia);
  const downloadable = (rawMedia.document ?? rawMedia.photo) as
    | Record<string, unknown>
    | undefined;
  const rawId = readBigId(downloadable?.id);
  if (!descriptor || rawId === undefined) {
    throw mediaError("NO_MEDIA", "The message has no downloadable media", false);
  }
  const id = mediaId(source.source_id, messageId, descriptor.type, rawId);
  return {
    sourceId: source.source_id,
    messageId,
    sourceHandle: source.handle,
    descriptor: { ...descriptor, media_id: id },
    rawMessage,
    rawMedia,
  };
}

export async function readAssetBytes(
  client: TelegramLike,
  asset: MediaAsset,
  limit: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of iterAssetBytes(client, asset, { limit: limit + 1, signal })) {
    total += chunk.length;
    if (total > limit) throw mediaError("INLINE_LIMIT_EXCEEDED", `Media exceeds the ${limit}-byte inline limit`, false);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

export async function* iterAssetBytes(
  client: TelegramLike,
  asset: MediaAsset,
  options: { file?: unknown; offset?: number; limit?: number; signal?: AbortSignal } = {},
): AsyncGenerator<Buffer, void, unknown> {
  let remaining = options.limit;
  const iterator = client.iterDownload(options.file ?? asset.rawMessage, {
    ...(options.offset !== undefined ? { offset: options.offset } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    requestSize: 512 * 1024,
  });
  for await (const chunk of iterator) {
    if (options.signal?.aborted) throw new DOMException("Media download aborted", "AbortError");
    if (remaining === undefined) {
      yield chunk;
      continue;
    }
    if (remaining <= 0) return;
    const exact = chunk.subarray(0, remaining);
    remaining -= exact.length;
    if (exact.length > 0) yield exact;
  }
}
```

- [ ] **Step 8: Implement the minimal photo/voice service**

```ts
// src/media/service.ts
const productionMediaDependencies: MediaDependencies = {
  withClient: withTelegram,
  resolveAsset: resolveMediaAsset,
  readBytes: readAssetBytes,
};

function readyOutcome(asset: MediaAsset, artifact: MediaArtifact): MediaOutcome {
  const fileName = asset.descriptor.file_name;
  return {
    result: {
      status: "ready",
      source_id: asset.sourceId,
      message_id: asset.messageId,
      media: asset.descriptor,
      representation: {
        kind: artifact.type,
        mime_type: artifact.mimeType,
        ...(fileName ? { file_name: fileName } : {}),
        byte_size: artifact.data.length,
      },
    },
    artifact,
  };
}

function fallbackOutcome(
  asset: MediaAsset,
  code: MediaResultCode,
  retryable: boolean,
): MediaOutcome {
  return {
    result: {
      status: "fallback",
      source_id: asset.sourceId,
      message_id: asset.messageId,
      media: asset.descriptor,
      representation: { kind: "metadata" },
      code,
      retryable,
      message: "The media is available, but no bounded direct representation was produced.",
    },
  };
}

export async function getMedia(
  input: GetMediaInput,
  overrides: Partial<MediaDependencies> = {},
): Promise<MediaOutcome> {
  const deps = { ...productionMediaDependencies, ...overrides };
  return deps.withClient(async (client) => {
    const asset = await deps.resolveAsset(client, {
      sourceId: input.source_id,
      messageId: input.message_id,
    });
    if ((asset.descriptor.size ?? INLINE_MEDIA_MAX_BYTES + 1) > INLINE_MEDIA_MAX_BYTES) {
      return fallbackOutcome(asset, "INLINE_LIMIT_EXCEEDED", false);
    }
    if (!["photo", "voice", "audio"].includes(asset.descriptor.type)) {
      return fallbackOutcome(asset, "UNSUPPORTED_MEDIA", false);
    }
    const data = await deps.readBytes(client, asset, INLINE_MEDIA_MAX_BYTES);
    return readyOutcome(asset, {
      type: asset.descriptor.type === "photo" ? "image" : "audio",
      data,
      mimeType: asset.descriptor.mime_type ?? (asset.descriptor.type === "photo" ? "image/jpeg" : "audio/ogg"),
    });
  });
}
```

Add a serialization regression that JSON-stringifies both outcomes and asserts
that sentinel values placed in `rawMessage.fileReference` and
`rawMedia.accessHash` are absent.

- [ ] **Step 9: Register `get_media` and pin the twentieth tool**

```ts
// src/mcp/tools/get-media.ts
export function registerGetMedia(server: McpServer): void {
  server.registerTool("get_media", {
    title: "Inspect Telegram media",
    description: "Retrieve the media attached to one Telegram message when its contents may affect the answer. Pass source_id and message_id; normally omit mode because GramScope returns the best bounded representation automatically.",
    inputSchema: getMediaInputSchema,
    outputSchema: getMediaResultSchema,
    annotations: { readOnlyHint: true },
  }, async (input) => {
    const parsed = getMediaInputSchema.parse(input);
    return mediaToolResult(await getMedia(parsed));
  });
}
```

Import and call `registerGetMedia` from `src/mcp/server.ts`; add `get_media` to the read-only expected names in `tests/tools.test.ts` and `tests/mcp-handler.test.ts`; change assertions from nineteen to twenty. Do not add it to `WRITERS`.

- [ ] **Step 10: Add safe media log fields and redaction assertions**

```ts
// src/mcp/logging.ts
export type ToolCallLog = {
  name: string;
  durationMs: number;
  status: "success" | "error";
  count?: number;
  code?: string;
  mediaKind?: string;
  bytes?: number;
};
```

Append only `media_kind` and `bytes` in `formatToolCall`. In `tests/logging.test.ts`, pass a fake object containing `url`, `token`, `filename`, and `caption` through the media call path and assert none of those values appears in the formatted line.

- [ ] **Step 11: Run the Task 1 quality gate**

Run:

```bash
npx vitest run tests/media-service.test.ts tests/telegram-client.test.ts tests/logging.test.ts tests/tools.test.ts tests/mcp-handler.test.ts
npm test
npm run typecheck
npm run lint
npm run build
```

Expected: all commands pass; the build exposes exactly twenty tools.

- [ ] **Step 12: Commit, deploy, and run the direct-content compatibility gate**

```bash
git add src/schemas/media.ts src/telegram/media.ts src/media/service.ts src/mcp/media-result.ts src/mcp/tools/get-media.ts src/telegram/client.ts src/mcp/tool-result.ts src/mcp/logging.ts src/mcp/server.ts tests/media-service.test.ts tests/telegram-client.test.ts tests/logging.test.ts tests/tools.test.ts tests/mcp-handler.test.ts tests/tool-names.ts
git commit -m "feat: add one-call Telegram media vertical slice"
git push origin main
```

Wait for the Git-connected Vercel production deployment, refresh the custom app's actions, then in an ordinary ChatGPT Project chat run two prompts against real selectors:

Before sending, replace the two `GRAMSCOPE_LIVE_*` names with their actual
non-secret source/message values from `.env.local`; never paste session or
token values.

```text
Use GramScope to inspect the photo message identified by GRAMSCOPE_LIVE_MEDIA_SOURCE and GRAMSCOPE_LIVE_PHOTO_MESSAGE_ID from the acceptance setup. Describe only what is visible in the returned media.
Use GramScope to inspect the voice message identified by GRAMSCOPE_LIVE_MEDIA_SOURCE and GRAMSCOPE_LIVE_VOICE_MESSAGE_ID from the acceptance setup. State whether you received usable audio; do not infer its contents from metadata.
```

Record tool-call count, returned content types, whether the model actually used
the bytes, and elapsed time in `docs/media-chatgpt-acceptance.md`. Continue with
Tasks 2–4 in order regardless of the result. If image or audio direct content
is not usable, do not add reasoning or transcription; after Task 4 supplies
same-call `resource_link`, rerun these prompts and record that fallback before
starting Task 5.

---

### Task 2: Complete download-free metadata and stable media identity

**Files:**

- Modify: `src/schemas/media.ts`
- Modify: `src/schemas/message.ts`
- Modify: `src/telegram/media.ts`
- Modify: `src/telegram/message-slice.ts`
- Modify: `tests/schemas-message.test.ts`
- Modify: `tests/telegram-message-slice.test.ts`
- Modify: `tests/telegram-messages.test.ts`
- Modify: `tests/telegram-search.test.ts`
- Modify: `tests/telegram-thread.test.ts`
- Modify: `tests/telegram-pinned.test.ts`

**Interfaces:**

- Consumes: `MediaDescriptor`, `MediaAsset`, and `normalizeMediaAsset` from Task 1.
- Produces: `messageMediaSchema` and complete `mediaOf(media, identity?)` metadata using Task 1's `mediaId`. The existing search-filter enum stays unchanged: Telegram has no exact sticker filter, and using the generic document filter would corrupt page size and cursor semantics.

- [ ] **Step 1: Write failing metadata/classification tests**

```ts
// append to tests/schemas-message.test.ts
const identity = { sourceId: CHAT_ID, messageId: 42 };

function documentMedia(document: Record<string, unknown>) {
  return {
    className: "MessageMediaDocument",
    document: {
      className: "Document",
      mimeType: "application/octet-stream",
      size: 0n,
      attributes: [],
      ...document,
    },
  };
}

it("classifies a round video as video_note and exposes dimensions/duration", () => {
  expect(mediaOf(documentMedia({
    id: 99n,
    mimeType: "video/mp4",
    size: 5000n,
    attributes: [{
      className: "DocumentAttributeVideo",
      roundMessage: true,
      w: 480,
      h: 480,
      duration: 12.5,
    }],
  }), { sourceId: CHAT_ID, messageId: 42 })).toMatchObject({
    media_id: expect.stringMatching(/^med_/),
    type: "video_note",
    width: 480,
    height: 480,
    duration_seconds: 12.5,
    size: 5000,
  });
});

it("changes media_id when attached media changes, not when file_reference changes", () => {
  const a = mediaOf(documentMedia({ id: 99n, fileReference: Buffer.from("a") }), identity);
  const b = mediaOf(documentMedia({ id: 99n, fileReference: Buffer.from("b") }), identity);
  const c = mediaOf(documentMedia({ id: 100n, fileReference: Buffer.from("a") }), identity);
  expect(a?.media_id).toBe(b?.media_id);
  expect(c?.media_id).not.toBe(a?.media_id);
});

it("leaves URL metadata download-free and without media_id", () => {
  expect(mediaOf({ className: "MessageMediaWebPage" }, identity)).toEqual({ type: "url" });
});
```

- [ ] **Step 2: Run the focused tests and verify red**

Run: `npx vitest run tests/schemas-message.test.ts`

Expected: FAIL on `video_note`, dimensions, duration, and `media_id`.

- [ ] **Step 3: Implement the canonical identity and enriched mapper**

```ts
// src/schemas/message.ts
import { mediaDescriptorSchema, mediaId } from "./media";

export const messageMediaSchema = mediaDescriptorSchema.partial({
  media_id: true,
});

type MediaIdentity = { sourceId: string; messageId: number };

function withIdentity(
  descriptor: Omit<MediaDescriptor, "media_id">,
  rawId: string | undefined,
  identity: MediaIdentity | undefined,
): TelegramMessage["media"] {
  return {
    ...descriptor,
    ...(rawId !== undefined && identity !== undefined
      ? { media_id: mediaId(identity.sourceId, identity.messageId, descriptor.type, rawId) }
      : {}),
  };
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

export function mediaOf(
  media: unknown,
  identity?: MediaIdentity,
): TelegramMessage["media"] | undefined {
  if (typeof media !== "object" || media === null) return undefined;
  const raw = media as Record<string, unknown>;
  if (raw.className === "MessageMediaWebPage") return { type: "url" };

  if (raw.className === "MessageMediaPhoto") {
    const photo = (raw.photo ?? {}) as Record<string, unknown>;
    const sizes = Array.isArray(photo.sizes)
      ? photo.sizes as Record<string, unknown>[]
      : [];
    const largest = sizes
      .filter((size) => finitePositive(size.w) && finitePositive(size.h))
      .sort((a, b) => Number(b.w) * Number(b.h) - Number(a.w) * Number(a.h))[0];
    return withIdentity({
      type: "photo",
      ...(largest ? { width: Number(largest.w), height: Number(largest.h) } : {}),
      has_thumbnail: sizes.length > 0,
    }, readBigId(photo.id), identity);
  }

  if (raw.className !== "MessageMediaDocument") {
    const name = String(raw.className ?? "");
    return name.startsWith("MessageMedia")
      ? { type: name.slice("MessageMedia".length).toLowerCase() }
      : undefined;
  }

  const document = (raw.document ?? {}) as Record<string, unknown>;
  const attrs = attributesOf(document);
  const animated = attrs.some((attr) => attr.className === "DocumentAttributeAnimated");
  const sticker = attrs.some((attr) => attr.className === "DocumentAttributeSticker");
  const video = attrs.find((attr) => attr.className === "DocumentAttributeVideo");
  const audio = attrs.find((attr) => attr.className === "DocumentAttributeAudio");
  const filename = attrs.find((attr) => attr.className === "DocumentAttributeFilename")?.fileName;
  const type = animated ? "gif"
    : sticker ? "sticker"
    : video ? (video.roundMessage === true ? "video_note" : "video")
    : audio ? (audio.voice === true ? "voice" : "audio")
    : "document";
  const rawSize = readBigId(document.size);
  const size = rawSize === undefined ? undefined : Number(rawSize);
  return withIdentity({
    type,
    ...(typeof filename === "string" ? { file_name: filename } : {}),
    ...(typeof document.mimeType === "string" ? { mime_type: document.mimeType } : {}),
    ...(size !== undefined && Number.isSafeInteger(size) && size >= 0 ? { size } : {}),
    ...(video && finitePositive(video.w) ? { width: Number(video.w) } : {}),
    ...(video && finitePositive(video.h) ? { height: Number(video.h) } : {}),
    ...((video ?? audio) && finitePositive((video ?? audio)!.duration)
      ? { duration_seconds: Number((video ?? audio)!.duration) }
      : {}),
    has_thumbnail: Array.isArray(document.thumbs) && document.thumbs.length > 0,
  }, readBigId(document.id), identity);
}
```

Call `mediaOf(m.media, { sourceId: ctx.chatId, messageId: id })` in `mapMessage`. Keep URL and service-media fallback types metadata-only.

- [ ] **Step 4: Prove existing readers never download**

Add this explicit no-download member to the fake-client builders in the
reading/search/thread/pinned suites and assert it remains untouched after each
representative call:

```ts
const iterDownload = vi.fn(async function* () {
  throw new Error("a metadata-only tool attempted a media download");
});

const client = { ...existingFakeClient, iterDownload } as TelegramLike;

// after getMessages/searchMessages/getThread/getPinnedMessages:
expect(client.iterDownload).not.toHaveBeenCalled();
```

- [ ] **Step 5: Preserve exact filtering and add a regression for the decision**

Do not add `sticker` or `video_note` to `MEDIA_TYPES` in
`src/telegram/message-slice.ts` in this delivery. The metadata mapper still
reports both types, while search filtering retains its existing exact Telegram
filters. Add this assertion to `tests/telegram-message-slice.test.ts`:

```ts
expect(MEDIA_TYPES).toEqual([
  "photo", "video", "document", "audio", "voice", "url", "gif",
]);
```

This prevents a later implementation from mapping `sticker` to the broad
document filter and returning non-sticker rows under a sticker request.

- [ ] **Step 6: Run Task 2 verification**

Run:

```bash
npx vitest run tests/schemas-message.test.ts tests/telegram-message-slice.test.ts tests/telegram-messages.test.ts tests/telegram-search.test.ts tests/telegram-thread.test.ts tests/telegram-pinned.test.ts
npm test
npm run typecheck
npm run lint
```

Expected: all pass; every old read/search result carries richer metadata but makes zero download calls.

- [ ] **Step 7: Commit**

```bash
git add src/schemas/media.ts src/schemas/message.ts src/telegram/media.ts src/telegram/message-slice.ts tests/schemas-message.test.ts tests/telegram-message-slice.test.ts tests/telegram-messages.test.ts tests/telegram-search.test.ts tests/telegram-thread.test.ts tests/telegram-pinned.test.ts
git commit -m "feat: enrich Telegram media metadata"
git push origin main
```

---
### Task 3: Complete the one-call image and source-audio fast paths

**Files:**

- Create: `src/media/names.ts`
- Create: `src/media/image.ts`
- Create: `tests/media-image.test.ts`
- Modify: `src/media/service.ts`
- Modify: `src/telegram/media.ts`
- Modify: `tests/media-service.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**

- Consumes: complete `MediaAsset` and `readAssetBytes` from Tasks 1–2.
- Produces:

```ts
export function safeMediaFilename(input: {
  supplied?: string;
  kind: string;
  messageId: number;
  mimeType?: string;
}): string;

export type ProcessedImage = {
  data: Buffer;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
};

export async function normalizeImage(
  source: Buffer,
  options?: { preserveTransparency?: boolean; sourceMimeType?: string },
): Promise<ProcessedImage>;
```

- `normalizeImage` always returns at most 2 MiB and at most 1600 px on the long edge. It tries the source unchanged first when its MIME/size already satisfies the direct-content contract.
- `resolveMediaAsset` is extended to attach an internal `thumbnailLocation` for the best Telegram photo/document thumbnail near a 1280 px long edge. The location never leaves the service.

- [ ] **Step 1: Install sharp and write failing filename/image tests**

Run: `npm install sharp`

```ts
// tests/media-image.test.ts
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { normalizeImage } from "@/media/image";
import { safeMediaFilename } from "@/media/names";
import { INLINE_MEDIA_MAX_BYTES } from "@/schemas/media";

describe("safeMediaFilename", () => {
  it("removes paths and control characters", () => {
    expect(safeMediaFilename({
      supplied: "../bad\u0000/name.ogg",
      kind: "voice",
      messageId: 42,
      mimeType: "audio/ogg",
    })).toBe("name.ogg");
    expect(safeMediaFilename({
      supplied: "..\\bad\\voice.ogg",
      kind: "voice",
      messageId: 42,
      mimeType: "audio/ogg",
    })).toBe("voice.ogg");
  });

  it("derives a stable extension when Telegram omitted the name", () => {
    expect(safeMediaFilename({ kind: "voice", messageId: 42, mimeType: "audio/ogg" }))
      .toBe("voice-42.ogg");
  });
});

describe("normalizeImage", () => {
  it("returns an already suitable source image unchanged", async () => {
    const source = await sharp({
      create: { width: 320, height: 180, channels: 3, background: "#cc3311" },
    }).jpeg().toBuffer();
    const image = await normalizeImage(source, { sourceMimeType: "image/jpeg" });
    expect(image.data).toBe(source);
    expect(image).toMatchObject({ mimeType: "image/jpeg", width: 320, height: 180 });
  });

  it("bounds dimensions and encoded bytes", async () => {
    const source = await sharp({
      create: { width: 4000, height: 3000, channels: 3, background: "#cc3311" },
    }).jpeg({ quality: 100 }).toBuffer();
    const image = await normalizeImage(source);
    expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(1600);
    expect(image.data.length).toBeLessThanOrEqual(INLINE_MEDIA_MAX_BYTES);
    expect(image.mimeType).toBe("image/jpeg");
  });
});
```

- [ ] **Step 2: Run the focused tests and verify red**

Run: `npx vitest run tests/media-image.test.ts`

Expected: FAIL because `@/media/image` and `@/media/names` do not exist.

- [ ] **Step 3: Implement stable safe filenames**

```ts
// src/media/names.ts
import path from "node:path";

const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "application/pdf": ".pdf",
};

export function safeMediaFilename(input: {
  supplied?: string;
  kind: string;
  messageId: number;
  mimeType?: string;
}): string {
  const basename = input.supplied
    ? path.posix.basename(
        input.supplied.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\\/g, "/"),
      )
    : "";
  if (basename && basename !== "." && basename !== "..") return basename.slice(-180);
  const extension = MIME_EXTENSIONS[input.mimeType ?? ""] ?? ".bin";
  return `${input.kind}-${input.messageId}${extension}`;
}
```

- [ ] **Step 4: Implement bounded image normalization**

```ts
// src/media/image.ts
import sharp from "sharp";
import { INLINE_MEDIA_MAX_BYTES } from "../schemas/media";

const QUALITIES = [82, 72, 62, 55] as const;
const EDGES = [1600, 1280, 1024, 768] as const;

export async function normalizeImage(
  source: Buffer,
  options: { preserveTransparency?: boolean; sourceMimeType?: string } = {},
): Promise<ProcessedImage> {
  const metadata = await sharp(source).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  const supportedSourceMime = ["image/jpeg", "image/png", "image/webp"].includes(
    options.sourceMimeType ?? "",
  );
  if (
    supportedSourceMime &&
    source.length <= INLINE_MEDIA_MAX_BYTES &&
    width > 0 &&
    height > 0 &&
    Math.max(width, height) <= 1600
  ) {
    return {
      data: source,
      mimeType: options.sourceMimeType as ProcessedImage["mimeType"],
      width,
      height,
    };
  }
  for (const edge of EDGES) {
    for (const quality of QUALITIES) {
      const pipeline = sharp(source, { failOn: "warning" })
        .rotate()
        .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true });
      const transparent = options.preserveTransparency === true && metadata.hasAlpha === true;
      const { data, info } = await (transparent
        ? pipeline.webp({ quality, alphaQuality: quality })
        : pipeline.jpeg({ quality, mozjpeg: true }))
        .toBuffer({ resolveWithObject: true });
      if (data.length <= INLINE_MEDIA_MAX_BYTES) {
        return {
          data,
          mimeType: transparent ? "image/webp" : "image/jpeg",
          width: info.width,
          height: info.height,
        };
      }
    }
  }
  throw mediaError("INLINE_LIMIT_EXCEEDED", "Image cannot fit the inline media limit", false);
}
```

Add a transparent PNG fixture to the same test and assert the returned MIME is
`image/webp` when `preserveTransparency: true`.

- [ ] **Step 5: Write failing deterministic `auto` tests**

```ts
// append to tests/media-service.test.ts
it.each([
  ["photo", "image/jpeg", "image"],
  ["document", "image/png", "image"],
  ["voice", "audio/ogg", "audio"],
  ["audio", "audio/mpeg", "audio"],
] as const)("auto returns one direct artifact for %s", async (kind, mime, expected) => {
  const outcome = await getMedia({ source_id: "-1001", message_id: 7, mode: "auto", max_frames: 8 },
    fakeMediaDeps({ asset: fakeAsset({ type: kind, mime_type: mime, size: 128 }), bytes: Buffer.alloc(128) }));
  expect(outcome.result.status).toBe("ready");
  expect(outcome.artifact?.type).toBe(expected);
  expect(outcome.result.representation?.file_name).toBeTruthy();
});

it("does not download audio declared above the inline cap", async () => {
  const deps = fakeMediaDeps({ asset: fakeAsset({ type: "voice", size: INLINE_MEDIA_MAX_BYTES + 1 }) });
  const outcome = await getMedia(input(), deps);
  expect(deps.readBytes).not.toHaveBeenCalled();
  expect(outcome.result).toMatchObject({ status: "fallback", code: "INLINE_LIMIT_EXCEEDED" });
});

it("timestamps imply frames and original conflicts before Telegram access", async () => {
  expect(() => getMediaInputSchema.parse({
    source_id: "-1001", message_id: 7, mode: "original", timestamps_seconds: [1],
  })).toThrow();
});
```

- [ ] **Step 6: Extend the service switch without adding model choices**

In `src/telegram/media.ts`, build the selected thumbnail location with the TL
namespace obtained from `getApi()`:

```ts
async function thumbnailLocation(rawMedia: Record<string, unknown>): Promise<unknown | undefined> {
  const Api = await getApi();
  const photo = rawMedia.photo as Record<string, unknown> | undefined;
  if (photo) {
    const selected = selectThumbnail(photo.sizes, 1280);
    if (!selected) return undefined;
    return new Api.InputPhotoFileLocation({
      id: photo.id as never,
      accessHash: photo.accessHash as never,
      fileReference: photo.fileReference as never,
      thumbSize: String(selected.type ?? "y"),
    });
  }
  const document = rawMedia.document as Record<string, unknown> | undefined;
  if (document) {
    const selected = selectThumbnail(document.thumbs, 1280);
    if (!selected) return undefined;
    return new Api.InputDocumentFileLocation({
      id: document.id as never,
      accessHash: document.accessHash as never,
      fileReference: document.fileReference as never,
      thumbSize: String(selected.type ?? "y"),
    });
  }
  return undefined;
}

function selectThumbnail(raw: unknown, targetLongEdge: number): Record<string, unknown> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const sizes = (raw as Record<string, unknown>[])
    .filter((size) =>
      !["PhotoStrippedSize", "PhotoCachedSize"].includes(String(size.className)) &&
      typeof size.w === "number" && typeof size.h === "number")
    .sort((a, b) => Math.max(Number(a.w), Number(a.h)) - Math.max(Number(b.w), Number(b.h)));
  return sizes.find((size) => Math.max(Number(size.w), Number(size.h)) >= targetLongEdge)
    ?? sizes.at(-1);
}
```

The selector ignores stripped/cached placeholders and chooses the smallest size
whose long edge is at least 1280, or otherwise the largest real size.
Extend `iterAssetBytes` with an internal `file?: unknown` option and pass
`file ?? asset.rawMessage` to `client.iterDownload`. Export
`readAssetThumbnail(client, asset, limit, signal?)`; it downloads
`asset.thumbnailLocation` with `limit + 1`, returns `undefined` when no location
exists, and raises `INLINE_LIMIT_EXCEEDED` before returning an oversized block.

At the end of `resolveMediaAsset`, attach it without changing the public
descriptor:

```ts
const asset = normalizeMediaAsset(source, rawMessage, rawMedia);
const location = await thumbnailLocation(rawMedia);
return {
  ...asset,
  ...(location !== undefined ? { thumbnailLocation: location } : {}),
};
```

Extend the existing `productionMediaDependencies` object with the concrete
Task 3 functions (tests continue to override them structurally):

```ts
readThumbnail: readAssetThumbnail,
normalizeImage,
```

Then implement this deterministic switch in `src/media/service.ts`.
Import `safeMediaFilename` and replace `readyOutcome`'s optional raw Telegram
name with this stable sanitized value for every direct artifact:

```ts
const fileName = safeMediaFilename({
  supplied: asset.descriptor.file_name,
  kind: asset.descriptor.type,
  messageId: asset.messageId,
  mimeType: artifact.mimeType,
});
```

```ts
async function represent(
  client: TelegramLike,
  asset: MediaAsset,
  input: GetMediaInput,
  deps: MediaDependencies,
): Promise<MediaOutcome> {
  const mode = input.timestamps_seconds?.length ? "frames" : input.mode;
  if (mode === "original") {
    const base = asset.descriptor.size !== undefined &&
        asset.descriptor.size <= INLINE_MEDIA_MAX_BYTES &&
        (isDirectImage(asset) || isDirectAudio(asset))
      ? await directOriginal(client, asset, deps)
      : fallbackOutcome(asset, "INLINE_LIMIT_EXCEEDED", false);
    return deps.attachOriginalLink
      ? deps.attachOriginalLink(asset, base)
      : base;
  }
  if (mode === "preview") {
    return ["photo", "sticker"].includes(asset.descriptor.type) ||
        (asset.descriptor.type === "document" && asset.descriptor.mime_type?.startsWith("image/"))
      ? directImage(client, asset, deps)
      : thumbnailFallback(client, asset, deps);
  }
  if (mode === "frames") {
    if (!["video", "gif", "video_note"].includes(asset.descriptor.type)) {
      return errorOutcome(asset, "UNSUPPORTED_MEDIA", false);
    }
    return deps.contactSheet
      ? directContactSheet(client, asset, input, deps)
      : thumbnailFallback(client, asset, deps);
  }

  switch (asset.descriptor.type) {
    case "photo":
      return directImage(client, asset, deps);
    case "voice":
    case "audio":
      return directAudioOrFallback(client, asset, deps);
    case "video":
    case "gif":
    case "video_note":
      return deps.contactSheet
        ? directContactSheet(client, asset, input, deps)
        : thumbnailFallback(client, asset, deps);
    case "sticker":
      return asset.descriptor.mime_type?.startsWith("image/")
        ? directImage(client, asset, deps)
        : thumbnailFallback(client, asset, deps);
    case "document":
      return asset.descriptor.mime_type?.startsWith("image/")
        ? directImage(client, asset, deps)
        : thumbnailFallback(client, asset, deps);
    default:
      return errorOutcome(asset, "UNSUPPORTED_MEDIA", false);
  }
}

function isDirectImage(asset: MediaAsset): boolean {
  return asset.descriptor.type === "photo" ||
    (["sticker", "document"].includes(asset.descriptor.type) &&
      asset.descriptor.mime_type?.startsWith("image/") === true);
}

function isDirectAudio(asset: MediaAsset): boolean {
  return ["voice", "audio"].includes(asset.descriptor.type);
}

async function directOriginal(
  client: TelegramLike,
  asset: MediaAsset,
  deps: MediaDependencies,
): Promise<MediaOutcome> {
  const data = await deps.readBytes(client, asset, INLINE_MEDIA_MAX_BYTES);
  return readyOutcome(asset, {
    type: isDirectImage(asset) ? "image" : "audio",
    data,
    mimeType: asset.descriptor.mime_type ??
      (isDirectImage(asset) ? "image/jpeg" : "audio/ogg"),
  });
}

async function directAudioOrFallback(
  client: TelegramLike,
  asset: MediaAsset,
  deps: MediaDependencies,
): Promise<MediaOutcome> {
  if ((asset.descriptor.size ?? INLINE_MEDIA_MAX_BYTES + 1) > INLINE_MEDIA_MAX_BYTES) {
    const base = fallbackOutcome(asset, "INLINE_LIMIT_EXCEEDED", false);
    return deps.attachOriginalLink ? deps.attachOriginalLink(asset, base) : base;
  }
  return directOriginal(client, asset, deps);
}

async function directImage(
  client: TelegramLike,
  asset: MediaAsset,
  deps: MediaDependencies,
): Promise<MediaOutcome> {
  const thumbnail = await deps.readThumbnail?.(client, asset, INLINE_MEDIA_MAX_BYTES);
  const source = thumbnail?.data ??
    await deps.readBytes(client, asset, INLINE_MEDIA_MAX_BYTES);
  const processed = deps.normalizeImage
    ? await deps.normalizeImage(source, {
        preserveTransparency: asset.descriptor.mime_type === "image/png" ||
          asset.descriptor.mime_type === "image/webp",
        sourceMimeType: thumbnail?.mimeType ?? asset.descriptor.mime_type,
      })
    : {
        data: source,
        mimeType: (thumbnail?.mimeType ?? asset.descriptor.mime_type ?? "image/jpeg") as "image/jpeg",
        width: asset.descriptor.width ?? 1,
        height: asset.descriptor.height ?? 1,
      };
  const outcome = readyOutcome(asset, {
    type: "image",
    data: processed.data,
    mimeType: processed.mimeType,
  });
  outcome.result.representation = {
    ...outcome.result.representation!,
    width: processed.width,
    height: processed.height,
  };
  return outcome;
}

async function thumbnailFallback(
  client: TelegramLike,
  asset: MediaAsset,
  deps: MediaDependencies,
): Promise<MediaOutcome> {
  const thumbnail = await deps.readThumbnail?.(client, asset, INLINE_MEDIA_MAX_BYTES);
  const base = fallbackOutcome(asset, "UNSUPPORTED_MEDIA", false);
  if (thumbnail) {
    base.artifact = thumbnail;
    base.result.representation = {
      kind: "image",
      mime_type: thumbnail.mimeType,
      byte_size: thumbnail.data.length,
    };
  }
  return deps.attachOriginalLink ? deps.attachOriginalLink(asset, base) : base;
}

function errorOutcome(
  asset: MediaAsset,
  code: MediaResultCode,
  retryable: boolean,
): MediaOutcome {
  return {
    result: {
      ...fallbackOutcome(asset, code, retryable).result,
      status: "error",
    },
  };
}
```

Name the image body above `directImageOnce` and expose this bounded fallback
wrapper. This covers a Telegram thumbnail that still cannot fit after the
quality/dimension loop without returning an oversized or raw exception result:

```ts
async function directImage(
  client: TelegramLike,
  asset: MediaAsset,
  deps: MediaDependencies,
): Promise<MediaOutcome> {
  try {
    return await directImageOnce(client, asset, deps);
  } catch (error) {
    if (!(error instanceof GramScopeError) || error.code !== "INLINE_LIMIT_EXCEEDED") {
      throw error;
    }
    const base = fallbackOutcome(asset, "INLINE_LIMIT_EXCEEDED", false);
    return deps.attachOriginalLink ? deps.attachOriginalLink(asset, base) : base;
  }
}
```

`directAudioOrFallback` checks declared size before reading and checks measured
bytes while reading. It does not call `normalizeImage` and does not transcode.
`normalizeImage` itself performs the source-image pass-through check before any
re-encoding, so `directImage` has one deterministic code path.

- [ ] **Step 7: Run Task 3 verification**

Run:

```bash
npx vitest run tests/media-image.test.ts tests/media-service.test.ts
npm test
npm run typecheck
npm run lint
npm run build
```

Expected: PASS; no direct artifact exceeds 2 MiB and voice bytes equal the fake Telegram bytes exactly.

- [ ] **Step 8: Commit**

```bash
git add src/media/names.ts src/media/image.ts src/media/service.ts src/telegram/media.ts tests/media-image.test.ts tests/media-service.test.ts package.json package-lock.json
git commit -m "feat: add bounded image and source audio media paths"
git push origin main
```

---

### Task 4: Encrypted original links and chunked Range streaming

**Files:**

- Create: `src/media/token.ts`
- Create: `src/media/range.ts`
- Create: `src/media/original-route.ts`
- Create: `app/api/media/[token]/route.ts`
- Create: `tests/media-token.test.ts`
- Create: `tests/media-original-route.test.ts`
- Modify: `src/config.ts`
- Modify: `.env.example`
- Modify: `scripts/provision.sh`
- Modify: `src/media/service.ts`
- Modify: `src/mcp/media-result.ts`
- Modify: `tests/config.test.ts`

**Interfaces:**

- Consumes: `resolveMediaAsset`, `iterAssetBytes`, `safeMediaFilename`, `MediaOutcome`.
- Produces:

```ts
export type MediaTokenClaims = {
  v: 1;
  purpose: "telegram-original";
  sourceId: string;
  messageId: number;
  ownerId: string;
};

export async function issueMediaToken(
  claims: MediaTokenClaims,
  now?: Date,
  key?: Uint8Array,
): Promise<{ token: string; expiresAt: Date }>;

export async function verifyMediaToken(
  token: string,
  now?: Date,
  key?: Uint8Array,
): Promise<MediaTokenClaims>;

export type ByteRange = { start: number; end: number; length: number };
export function parseSingleRange(header: string | null, size: number): ByteRange | undefined;

export class RangeNotSatisfiableError extends Error {
  constructor(public readonly size: number) {
    super("Requested byte range is not satisfiable");
  }
}

export type OriginalRouteDependencies = {
  verifyToken(token: string): Promise<MediaTokenClaims>;
  withClient<T>(run: (client: TelegramLike) => Promise<T>): Promise<T>;
  resolveAsset(client: TelegramLike, input: { sourceId: string; messageId: number }): Promise<MediaAsset>;
  iterBytes(
    client: TelegramLike,
    asset: MediaAsset,
    options: { offset?: number; limit?: number; signal?: AbortSignal },
  ): AsyncIterable<Buffer>;
  ownerId: string;
};

export async function handleOriginalRequest(
  request: Request,
  token: string,
  deps?: Partial<OriginalRouteDependencies>,
): Promise<Response>;
```

- [ ] **Step 1: Write failing config and JWE tests**

```ts
// tests/media-token.test.ts
import { describe, expect, it } from "vitest";
import { decodeProtectedHeader } from "jose";
import { issueMediaToken, verifyMediaToken } from "@/media/token";

const KEY = new Uint8Array(32).fill(7);

const claims: MediaTokenClaims = {
  v: 1,
  purpose: "telegram-original",
  sourceId: "-1001",
  messageId: 7,
  ownerId: "owner-1",
};

it("round-trips an encrypted ten-minute capability", async () => {
  const now = new Date("2026-08-30T12:00:00Z");
  const issued = await issueMediaToken({
    v: 1, purpose: "telegram-original", sourceId: "-1001", messageId: 7, ownerId: "owner-1",
  }, now, KEY);
  expect(decodeProtectedHeader(issued.token)).toMatchObject({ alg: "dir", enc: "A256GCM" });
  expect(issued.token).not.toContain("-1001");
  expect(issued.expiresAt.toISOString()).toBe("2026-08-30T12:10:00.000Z");
  await expect(verifyMediaToken(issued.token, new Date("2026-08-30T12:09:59Z"), KEY))
    .resolves.toMatchObject({ sourceId: "-1001", messageId: 7 });
});

it("rejects tampering and expiry with the same safe error", async () => {
  const issued = await issueMediaToken(claims, new Date("2026-08-30T12:00:00Z"), KEY);
  await expect(verifyMediaToken(`${issued.token}x`, new Date(), KEY)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  await expect(verifyMediaToken(issued.token, new Date("2026-08-30T12:10:01Z"), KEY))
    .rejects.toMatchObject({ code: "AUTH_REQUIRED" });
});
```

In `tests/config.test.ts`, assert missing, malformed, and non-32-byte `MEDIA_TOKEN_SECRET` are rejected without echoing the secret.

- [ ] **Step 2: Implement config parsing and compact JWE**

Add `mediaTokenSecret: Uint8Array` to `Config`. Decode base64url once in `loadConfig`, require exactly 32 bytes, and never retain the encoded string.

```ts
function requiredMediaTokenSecret(env: Env): Uint8Array {
  const encoded = required(env, "MEDIA_TOKEN_SECRET");
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error("MEDIA_TOKEN_SECRET must be base64url without padding");
  }
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.length !== 32) {
    throw new Error("MEDIA_TOKEN_SECRET must decode to exactly 32 bytes");
  }
  return new Uint8Array(bytes);
}
```

Set `mediaTokenSecret: requiredMediaTokenSecret(env)` in `loadConfig`.

```ts
// src/media/token.ts
import { EncryptJWT, jwtDecrypt } from "jose";
import { z } from "zod";
import { loadConfig } from "../config";

const TTL_SECONDS = 10 * 60;

const mediaTokenClaimsSchema = z.object({
  v: z.literal(1),
  purpose: z.literal("telegram-original"),
  sourceId: z.string().min(1),
  messageId: z.number().int().positive(),
  ownerId: z.string().min(1),
});

export async function issueMediaToken(
  claims: MediaTokenClaims,
  now = new Date(),
  key = loadConfig().mediaTokenSecret,
) {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const expiresAt = new Date((issuedAt + TTL_SECONDS) * 1000);
  const token = await new EncryptJWT(claims)
    .setProtectedHeader({ alg: "dir", enc: "A256GCM", typ: "JWT" })
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + TTL_SECONDS)
    .encrypt(key);
  return { token, expiresAt };
}

export async function verifyMediaToken(
  token: string,
  now = new Date(),
  key = loadConfig().mediaTokenSecret,
) {
  try {
    const { payload, protectedHeader } = await jwtDecrypt(token, key, {
      keyManagementAlgorithms: ["dir"],
      contentEncryptionAlgorithms: ["A256GCM"],
      currentDate: now,
    });
    if (protectedHeader.typ !== "JWT" || payload.v !== 1 || payload.purpose !== "telegram-original") throw new Error("claims");
    return mediaTokenClaimsSchema.parse(payload);
  } catch {
    throw new GramScopeError("AUTH_REQUIRED", "The media link is invalid or expired");
  }
}
```

- [ ] **Step 3: Write failing byte-range tests**

```ts
// tests/media-original-route.test.ts
it.each([
  [null, undefined],
  ["bytes=0-9", { start: 0, end: 9, length: 10 }],
  ["bytes=90-", { start: 90, end: 99, length: 10 }],
  ["bytes=-10", { start: 90, end: 99, length: 10 }],
])("parses %s", (header, expected) => {
  expect(parseSingleRange(header, 100)).toEqual(expected);
});

it.each(["bytes=100-101", "bytes=20-10", "bytes=0-1,4-5", "items=0-1"])
  ("rejects invalid or multiple range %s", (header) => {
    expect(() => parseSingleRange(header, 100)).toThrow(RangeNotSatisfiableError);
  });
```

- [ ] **Step 4: Implement exact single-range parsing**

```ts
// src/media/range.ts
export class RangeNotSatisfiableError extends Error {
  constructor(public readonly size: number) {
    super("Requested byte range is not satisfiable");
  }
}

export function parseSingleRange(header: string | null, size: number): ByteRange | undefined {
  if (header === null) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) throw new RangeNotSatisfiableError(size);
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new RangeNotSatisfiableError(size);
    const length = Math.min(suffix, size);
    return { start: size - length, end: size - 1, length };
  }
  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    throw new RangeNotSatisfiableError(size);
  }
  return { start, end, length: end - start + 1 };
}
```

- [ ] **Step 5: Write failing full and partial streaming tests**

```ts
function routeAsset(size = 10): MediaAsset {
  return {
    sourceId: "-1001",
    messageId: 7,
    sourceHandle: "@news",
    descriptor: {
      media_id: "med_route",
      type: "document",
      mime_type: "application/octet-stream",
      file_name: "sample.bin",
      size,
    },
    rawMessage: { id: 7 },
    rawMedia: { className: "MessageMediaDocument" },
  };
}

function fakeOriginalDeps(options: {
  size?: number;
  iter?: (options: { offset?: number; limit?: number; signal?: AbortSignal }) => AsyncIterable<Buffer>;
} = {}): OriginalRouteDependencies {
  const client = {} as TelegramLike;
  return {
    verifyToken: vi.fn(async () => claims),
    withClient: async <T>(run: (value: TelegramLike) => Promise<T>) => run(client),
    resolveAsset: vi.fn(async () => routeAsset(options.size ?? 10)),
    iterBytes: (_client, _asset, input) =>
      options.iter?.(input) ?? (async function* () { yield Buffer.from("0123456789"); })(),
    ownerId: "owner-1",
  };
}

it("streams only the requested bytes and aborts without buffering the original", async () => {
  const chunksRequested: Array<{ offset?: number; limit?: number }> = [];
  const response = await handleOriginalRequest(
    new Request("https://gramscope.test/api/media/token", { headers: { range: "bytes=2-5" } }),
    "token",
    fakeOriginalDeps({
      size: 10,
      iter: async function* (options) {
        chunksRequested.push(options);
        yield Buffer.from("2345");
      },
    }),
  );
  expect(response.status).toBe(206);
  expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.text()).toBe("2345");
  expect(chunksRequested).toEqual([{ offset: 2, limit: 4 }]);
});

it("returns safe status codes for token, media, and Range failures", async () => {
  const invalidToken = fakeOriginalDeps();
  invalidToken.verifyToken = vi.fn(async () => { throw new GramScopeError("AUTH_REQUIRED", "invalid"); });
  expect((await handleOriginalRequest(new Request("https://x.test/api/media/x"), "x", invalidToken)).status).toBe(401);

  const wrongOwner = fakeOriginalDeps();
  wrongOwner.verifyToken = vi.fn(async () => ({ ...claims, ownerId: "owner-2" }));
  expect((await handleOriginalRequest(new Request("https://x.test/api/media/x"), "x", wrongOwner)).status).toBe(401);
  expect(wrongOwner.resolveAsset).not.toHaveBeenCalled();

  const missing = fakeOriginalDeps();
  missing.resolveAsset = vi.fn(async () => { throw mediaError("MEDIA_NOT_FOUND", "missing", false); });
  expect((await handleOriginalRequest(new Request("https://x.test/api/media/x"), "x", missing)).status).toBe(404);

  const rangeIterator = vi.fn(async function* () { yield Buffer.from("should-not-run"); });
  const rangeDeps = fakeOriginalDeps({ iter: rangeIterator });
  const range = await handleOriginalRequest(
    new Request("https://x.test/api/media/x", { headers: { range: "bytes=99-100" } }),
    "x",
    rangeDeps,
  );
  expect(range.status).toBe(416);
  expect(range.headers.get("content-range")).toBe("bytes */10");
  expect(rangeIterator).not.toHaveBeenCalled();
});

it("pulls one chunk at a time and propagates cancellation", async () => {
  let pulls = 0;
  let aborted = false;
  const deps = fakeOriginalDeps({
    size: 20 * 1024 * 1024,
    iter: async function* (options) {
      options.signal?.addEventListener("abort", () => { aborted = true; });
      while (!options.signal?.aborted) {
        pulls++;
        yield Buffer.alloc(512 * 1024);
      }
    },
  });
  const response = await handleOriginalRequest(new Request("https://x.test/api/media/x"), "x", deps);
  const reader = response.body!.getReader();
  await reader.read();
  expect(pulls).toBe(1);
  await reader.cancel();
  expect(aborted).toBe(true);
});
```

In the first test, also assert the full-request branch returns `200`,
`Content-Length: 10`, a sanitized attachment filename, and
`X-Content-Type-Options: nosniff`.

- [ ] **Step 6: Implement the streaming handler and thin Next route**

```ts
// app/api/media/[token]/route.ts
import { handleOriginalRequest } from "@/media/original-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  return handleOriginalRequest(request, (await context.params).token);
}
```

In `handleOriginalRequest`, verify the token first, require
`claims.ownerId === loadConfig().ownerUserId`, refetch the asset, parse the
Range against authoritative size, and bridge `iterAssetBytes` to a
`ReadableStream<Uint8Array>`. The stream's `cancel()` aborts an internal
`AbortController`; its `pull()` reads exactly one iterator chunk and enqueues
it. Emit the exact `Content-Type`, `Content-Length`, `Content-Disposition`,
`Accept-Ranges`, `Cache-Control`, `X-Content-Type-Options`, and conditional
`Content-Range` headers shown below. Never log `request.url` or `token`.

```ts
function productionOriginalRouteDependencies(): OriginalRouteDependencies {
  const config = loadConfig();
  return {
    verifyToken: (token) => verifyMediaToken(token, new Date(), config.mediaTokenSecret),
    withClient: withTelegram,
    resolveAsset: resolveMediaAsset,
    iterBytes: iterAssetBytes,
    ownerId: config.ownerUserId,
  };
}

export async function handleOriginalRequest(
  request: Request,
  token: string,
  overrides: Partial<OriginalRouteDependencies> = {},
): Promise<Response> {
  const deps = { ...productionOriginalRouteDependencies(), ...overrides };
  try {
    const claims = await deps.verifyToken(token);
    if (claims.ownerId !== deps.ownerId) return new Response("Unauthorized", { status: 401 });
    return await deps.withClient(async (client) => {
      const asset = await deps.resolveAsset(client, {
        sourceId: claims.sourceId,
        messageId: claims.messageId,
      });
      const size = asset.descriptor.size;
      if (size === undefined) return new Response("Media size unavailable", { status: 422 });
      const range = parseSingleRange(request.headers.get("range"), size);
      const abort = new AbortController();
      const iterator = deps.iterBytes(client, asset, {
        ...(range ? { offset: range.start, limit: range.length } : {}),
        signal: abort.signal,
      })[Symbol.asyncIterator]();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const next = await iterator.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
        async cancel() {
          abort.abort();
          await iterator.return?.();
        },
      });
      const filename = safeMediaFilename({
        supplied: asset.descriptor.file_name,
        kind: asset.descriptor.type,
        messageId: asset.messageId,
        mimeType: asset.descriptor.mime_type,
      });
      const length = range?.length ?? size;
      const headers = new Headers({
        "content-type": asset.descriptor.mime_type ?? "application/octet-stream",
        "content-length": String(length),
        "content-disposition": contentDispositionAttachment(filename),
        "accept-ranges": "bytes",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      });
      if (range) headers.set("content-range", `bytes ${range.start}-${range.end}/${size}`);
      return new Response(body, { status: range ? 206 : 200, headers });
    });
  } catch (error) {
    if (error instanceof RangeNotSatisfiableError) {
      return new Response("Range Not Satisfiable", {
        status: 416,
        headers: { "content-range": `bytes */${error.size}` },
      });
    }
    if (error instanceof GramScopeError && error.code === "AUTH_REQUIRED") {
      return new Response("Unauthorized", { status: 401 });
    }
    if (error instanceof GramScopeError && ["MEDIA_NOT_FOUND", "NO_MEDIA"].includes(error.code)) {
      return new Response("Not Found", { status: 404 });
    }
    return new Response("Media download failed", { status: 502 });
  }
}
```

`contentDispositionAttachment` removes CR/LF and quotes, emits an ASCII
`filename=` fallback, and adds RFC 5987 `filename*=UTF-8''...` using
`encodeURIComponent`. Its tests use Cyrillic, quotes, and CR/LF input.

```ts
export function contentDispositionAttachment(filename: string): string {
  const clean = filename.replace(/[\r\n"]/g, "_");
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_") || "download.bin";
  const encoded = encodeURIComponent(clean)
    .replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
```

- [ ] **Step 7: Add same-call links to every fallback/original result**

Create one helper in `src/media/service.ts`:

```ts
async function attachOriginalLink(asset: MediaAsset, outcome: MediaOutcome): Promise<MediaOutcome> {
  const config = loadConfig();
  const issued = await issueMediaToken({
    v: 1,
    purpose: "telegram-original",
    sourceId: asset.sourceId,
    messageId: asset.messageId,
    ownerId: config.ownerUserId,
  });
  const uri = `${new URL(config.mcpResourceUrl).origin}/api/media/${encodeURIComponent(issued.token)}`;
  const name = safeMediaFilename({
    supplied: asset.descriptor.file_name,
    kind: asset.descriptor.type,
    messageId: asset.messageId,
    mimeType: asset.descriptor.mime_type,
  });
  return {
    ...outcome,
    result: { ...outcome.result, download: { url: uri, expires_at: issued.expiresAt.toISOString() } },
    link: { uri, name, mimeType: asset.descriptor.mime_type, size: asset.descriptor.size },
  };
}
```

Add `attachOriginalLink` to `productionMediaDependencies`; this is what turns
the optional Task 1 dependency hook into the production same-call fallback.

Use it for `mode: original`, every voice/audio outcome (bounded audio keeps its
direct source-byte artifact and gains the same-call link), generic documents
without thumbnails, unsupported stickers, and video `auto` degradation. This
keeps ordinary ChatGPT's audio compatibility fallback inside the same tool
call without transcoding or model-side mode selection. Add a regression that a
small voice outcome contains exactly one direct audio block and one
`resource_link`, both with the original MIME/size metadata. Never cache the
returned outcome because it contains a capability.

In Task 4, the small branch of `directAudioOrFallback` therefore becomes:

```ts
const direct = await directOriginal(client, asset, deps);
return deps.attachOriginalLink
  ? deps.attachOriginalLink(asset, direct)
  : direct;
```

- [ ] **Step 8: Extend provisioning without exposing the secret**

Add `MEDIA_TOKEN_SECRET` to `.env.example`, `REQUIRED_KEYS`, setup summary, Vercel publication, and the secret prompts in `scripts/provision.sh`. Generate it automatically when absent:

```bash
if [ -z "$(env_get MEDIA_TOKEN_SECRET)" ]; then
  value="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
  env_set MEDIA_TOKEN_SECRET "$value"
fi
```

Never echo `value` or place it in a process argument other than the existing stdin-based `env_set` path.

- [ ] **Step 9: Run Task 4 verification**

Run:

```bash
npx vitest run tests/config.test.ts tests/media-token.test.ts tests/media-original-route.test.ts tests/media-service.test.ts
npm test
npm run typecheck
npm run lint
npm run build
```

Expected: all pass; production build includes the Node streaming route and no secret appears in snapshots/output.

- [ ] **Step 10: Commit, deploy, and test large streaming/resource-link compatibility**

```bash
git add src/media/token.ts src/media/range.ts src/media/original-route.ts 'app/api/media/[token]/route.ts' tests/media-token.test.ts tests/media-original-route.test.ts src/config.ts .env.example scripts/provision.sh src/media/service.ts src/mcp/media-result.ts tests/config.test.ts
git commit -m "feat: stream Telegram originals through expiring links"
git push origin main
```

Publish `MEDIA_TOKEN_SECRET` through the existing provisioning/Vercel flow, wait for deployment, and verify with an actual original larger than 2 MiB:

Before deploying, confirm the project has Fluid Compute enabled (or that its
current plan otherwise accepts the route's `maxDuration = 300`). Treat the
deployed configuration—not an assumed plan name—as authoritative; compare it
with the current [Vercel Functions limits](https://vercel.com/docs/functions/limitations)
at implementation time.

```bash
read -r -s -p "Fresh signed media URL: " MEDIA_TEST_URL
curl -D - -o /dev/null "$MEDIA_TEST_URL"
curl -H "Range: bytes=0-1048575" -o /tmp/gramscope-range.bin "$MEDIA_TEST_URL"
wc -c /tmp/gramscope-range.bin
unset MEDIA_TEST_URL
```

Expected: the second response is `206`, file size is `1048576`, and
Vercel/function logs contain neither the token nor Telegram capability data.
If the deployed route cannot sustain the full original or the platform cannot
keep capability URLs out of access logs, this is a hard release blocker: stop
before Task 5, record the measured failure in the task card, and amend the
approved spec and this plan with a named private-object provider, an explicit
ten-minute deletion mechanism, and provider-specific tests. Do not guess a
provider during implementation, extend token lifetime, expose a public blob,
or buffer the original. Resume only after that amendment is approved.

Run the ordinary ChatGPT resource-link prompts from Task 1 if direct image/audio content failed, and append the actual outcome to `docs/media-chatgpt-acceptance.md`.

---

### Task 5: Bounded video/GIF/video-note contact sheets

**Files:**

- Create: `src/media/processor.ts`
- Create: `src/media/ffmpeg-processor.ts`
- Create: `tests/media-processor.test.ts`
- Modify: `src/media/service.ts`
- Modify: `src/media/image.ts`
- Modify: `src/telegram/media.ts`
- Modify: `next.config.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**

- Consumes: `MediaAsset`, bounded chunk iterator, image byte cap, and original-link fallback.
- Produces:

```ts
export type ContactSheetRequest = {
  timestampsSeconds: number[];
  maxBytes: number;
  maxLongEdge: number;
  deadline: AbortSignal;
};

export type ContactSheetResult = ProcessedImage & {
  frameCount: number;
  timestampsSeconds: number[];
};

export interface MediaProcessor {
  probeDuration(inputPath: string, deadline: AbortSignal): Promise<number>;
  contactSheet(inputPath: string, request: ContactSheetRequest): Promise<ContactSheetResult>;
}

export type FrameRunner = (
  args: string[],
  outputDirectory: string,
  signal: AbortSignal,
) => Promise<void>;

export function evenlySpacedTimestamps(durationSeconds: number, count: number): number[];
export function normalizeRequestedTimestamps(values: number[], durationSeconds: number): number[];
export function parseFfmpegDuration(stderr: string): number;
export function buildFfmpegArgs(inputPath: string, timestamps: number[], outputDirectory: string): string[];
export function createFfmpegProcessor(options?: { run?: FrameRunner }): MediaProcessor;
export const mediaProcessor: MediaProcessor;
```

The service constants are exact and are not environment-configurable in this
release:

```ts
export const AUTO_VIDEO_MAX_BYTES = 64 * 1024 * 1024;
export const AUTO_VIDEO_DEADLINE_MS = 25_000;
export const FRAMES_VIDEO_MAX_BYTES = 128 * 1024 * 1024;
export const FRAMES_VIDEO_DEADLINE_MS = 45_000;
```

- [ ] **Step 1: Install the native decoder and write failing pure contract tests**

Run: `npm install ffmpeg-static`

```ts
// tests/media-processor.test.ts
import { describe, expect, it } from "vitest";
import {
  buildFfmpegArgs,
  evenlySpacedTimestamps,
  normalizeRequestedTimestamps,
  parseFfmpegDuration,
} from "@/media/ffmpeg-processor";

it("places eight samples inside, not on, a 90-second video's endpoints", () => {
  expect(evenlySpacedTimestamps(90, 8)).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
});

it("builds one spawn argument vector and never a shell command", () => {
  const args = buildFfmpegArgs("/tmp/in;touch-pwned.mp4", [1.25, 8.5], "/tmp/frames");
  expect(args.filter((arg) => arg === "-i")).toHaveLength(2);
  expect(args).toContain("/tmp/in;touch-pwned.mp4");
  expect(args.join(" ")).not.toContain("sh -c");
  expect(args.filter((arg) => arg === "-frames:v")).toHaveLength(2);
});

it("rejects non-positive duration and more than ten frames", () => {
  expect(() => evenlySpacedTimestamps(0, 8)).toThrow();
  expect(() => evenlySpacedTimestamps(90, 11)).toThrow();
});

it("rounds, sorts, and rejects duplicate or out-of-duration timestamps", () => {
  expect(normalizeRequestedTimestamps([8.0004, 1.0004, 5], 10)).toEqual([1, 5, 8]);
  expect(() => normalizeRequestedTimestamps([1.0001, 1.0004], 10)).toThrow();
  expect(() => normalizeRequestedTimestamps([11], 10)).toThrow();
});

it("parses one bounded FFmpeg duration diagnostic", () => {
  expect(parseFfmpegDuration("Duration: 01:02:03.500, start: 0.000000"))
    .toBe(3723.5);
  expect(() => parseFfmpegDuration("Duration: N/A")).toThrow();
});
```

- [ ] **Step 2: Implement timestamp normalization and one-process FFmpeg arguments**

```ts
// src/media/ffmpeg-processor.ts
export function evenlySpacedTimestamps(durationSeconds: number, count: number): number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw mediaError("UNSUPPORTED_MEDIA", "Video duration is unavailable", false);
  if (!Number.isInteger(count) || count < 1 || count > MAX_FRAMES) throw new GramScopeError("INVALID_INPUT", `Frame count must be 1..${MAX_FRAMES}`);
  return Array.from({ length: count }, (_, index) =>
    Number((durationSeconds * (index + 1) / (count + 1)).toFixed(3)));
}

export function normalizeRequestedTimestamps(
  values: number[],
  durationSeconds: number,
): number[] {
  const rounded = values.map((value) => Math.round(value * 1000) / 1000);
  if (new Set(rounded).size !== rounded.length) {
    throw new GramScopeError("INVALID_INPUT", "timestamps_seconds must be unique after millisecond rounding");
  }
  if (rounded.some((value) => value < 0 || value > durationSeconds)) {
    throw new GramScopeError("INVALID_INPUT", `timestamps_seconds must be within the video duration ${durationSeconds}`);
  }
  return rounded.sort((a, b) => a - b);
}

export function parseFfmpegDuration(stderr: string): number {
  const match = /Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
  if (!match) throw mediaError("UNSUPPORTED_MEDIA", "Video duration is unavailable", false);
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw mediaError("UNSUPPORTED_MEDIA", "Video duration is unavailable", false);
  }
  return seconds;
}

export function buildFfmpegArgs(inputPath: string, timestamps: number[], outputDirectory: string): string[] {
  const inputs = timestamps.flatMap((timestamp) => ["-ss", timestamp.toFixed(3), "-i", inputPath]);
  const outputs = timestamps.flatMap((_, index) => [
    "-map", `${index}:v:0`, "-frames:v", "1", "-f", "image2", `${outputDirectory}/frame-${index}.png`,
  ]);
  return ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...inputs, ...outputs];
}
```

Invoke the resolved `ffmpeg-static` binary with `spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] })`; never use a shell. On abort, send `SIGKILL`, await process close, and discard stderr after a bounded 8 KiB diagnostic buffer.

- [ ] **Step 3: Write a failing processor integration test with injected runner**

```ts
it("labels and combines all frames into one bounded JPEG", async () => {
  const runner = async (_args: string[], directory: string) => {
    for (let i = 0; i < 3; i++) {
      await sharp({ create: { width: 320, height: 180, channels: 3, background: `rgb(${i * 40},20,30)` } })
        .png().toFile(`${directory}/frame-${i}.png`);
    }
  };
  const processor = createFfmpegProcessor({ run: runner });
  const result = await processor.contactSheet("/tmp/input.mp4", {
    timestampsSeconds: [1, 5, 9],
    maxBytes: INLINE_MEDIA_MAX_BYTES,
    maxLongEdge: 1600,
    deadline: new AbortController().signal,
  });
  expect(result.frameCount).toBe(3);
  expect(result.timestampsSeconds).toEqual([1, 5, 9]);
  expect(result.mimeType).toBe("image/jpeg");
  expect(result.data.length).toBeLessThanOrEqual(INLINE_MEDIA_MAX_BYTES);
  expect(await sharp(result.data).metadata()).toMatchObject({ format: "jpeg" });
});
```

- [ ] **Step 4: Implement the labelled contact sheet**

`createFfmpegProcessor` creates a unique temporary frame directory, calls its
`FrameRunner` exactly once with the complete argument vector and request abort
signal, reads each frame, and uses sharp `composite` with one SVG label per
cell. The default runner resolves `ffmpeg-static` and uses the non-shell
`spawn` path from Step 2; the injectable runner is test-only:

```ts
function timestampLabel(seconds: number, width: number): Buffer {
  const minutes = Math.floor(seconds / 60);
  const rest = (seconds % 60).toFixed(1).padStart(4, "0");
  return Buffer.from(`<svg width="${width}" height="28"><rect width="100%" height="28" fill="rgba(0,0,0,.65)"/><text x="8" y="20" fill="white" font-family="sans-serif" font-size="16">${minutes}:${rest}</text></svg>`);
}
```

Use a near-square grid (`columns = Math.ceil(Math.sqrt(frameCount))`), fixed equal cells, `fit: cover`, and the same quality/dimension reduction loop as `normalizeImage`. Remove the frame directory in `finally`. Return the exact normalized timestamps in the result.

- [ ] **Step 5: Write failing service budget/degradation tests**

```ts
function fakeVideoDeps() {
  const base = fakeMediaDeps({
    asset: fakeAsset({ type: "video", mime_type: "video/mp4", size: 10_000, duration_seconds: 90 }),
  });
  return {
    ...base,
    downloadToFile: vi.fn(async () => 10_000),
    contactSheet: vi.fn(async (_path, request) => ({
      data: Buffer.from("jpeg"),
      mimeType: "image/jpeg" as const,
      width: 1200,
      height: 800,
      frameCount: request.timestampsSeconds.length,
      timestampsSeconds: request.timestampsSeconds,
    })),
    attachOriginalLink: vi.fn(async (_asset, outcome) => ({
      ...outcome,
      result: {
        ...outcome.result,
        download: { url: "https://gramscope.test/api/media/test", expires_at: "2026-08-30T12:10:00.000Z" },
      },
      link: { uri: "https://gramscope.test/api/media/test", name: "video-7.mp4" },
    })),
  };
}

function fakeTimedOutVideoDeps(options: { thumbnail: boolean }) {
  const deps = fakeVideoDeps();
  deps.contactSheet = vi.fn(async () => {
    throw mediaError("PROCESSING_TIMEOUT", "Video processing exceeded its deadline", true);
  });
  return {
    ...deps,
    readThumbnail: options.thumbnail
      ? vi.fn(async () => ({
          type: "image" as const,
          data: Buffer.from("thumb"),
          mimeType: "image/jpeg",
        }))
      : vi.fn(async () => undefined),
  };
}

it("auto uses eight frames and the 64 MiB/25 second budget", async () => {
  const deps = fakeVideoDeps();
  await getMedia(input(), deps);
  expect(deps.contactSheet).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
    timestampsSeconds: [10, 20, 30, 40, 50, 60, 70, 80],
  }));
  expect(deps.downloadToFile).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    maxBytes: 64 * 1024 * 1024,
    deadlineMs: 25_000,
  }));
});

it("explicit timestamps are sorted and returned on one artifact", async () => {
  const outcome = await getMedia({
    source_id: "-1001", message_id: 7, mode: "auto", timestamps_seconds: [8, 1, 5], max_frames: 8,
  }, fakeVideoDeps());
  expect(outcome.result.representation?.timestamps_seconds).toEqual([1, 5, 8]);
  expect(outcome.artifact?.type).toBe("image");
});

it("explicit frames uses the 128 MiB/45 second budget", async () => {
  const deps = fakeVideoDeps();
  await getMedia({ ...input(), mode: "frames" }, deps);
  expect(deps.downloadToFile).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    maxBytes: 128 * 1024 * 1024,
    deadlineMs: 45_000,
  }));
});

it("probes a missing duration within the same deadline before spacing frames", async () => {
  const deps = fakeVideoDeps();
  deps.resolveAsset = vi.fn(async () => fakeAsset({
    type: "video", mime_type: "video/mp4", size: 10_000, duration_seconds: undefined,
  }));
  deps.probeDuration = vi.fn(async () => 90);
  await getMedia(input(), deps);
  expect(deps.probeDuration).toHaveBeenCalledOnce();
  expect(deps.contactSheet).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
    timestampsSeconds: [10, 20, 30, 40, 50, 60, 70, 80],
  }));
});

it("auto timeout returns thumbnail plus original link; explicit frames errors", async () => {
  const auto = await getMedia(input(), fakeTimedOutVideoDeps({ thumbnail: true }));
  expect(auto.result).toMatchObject({ status: "fallback", code: "PROCESSING_TIMEOUT" });
  expect(auto.artifact?.type).toBe("image");
  expect(auto.link).toBeDefined();
  const frames = await getMedia({ ...input(), mode: "frames" }, fakeTimedOutVideoDeps({ thumbnail: true }));
  expect(frames.result).toMatchObject({ status: "error", code: "PROCESSING_TIMEOUT" });
});
```

- [ ] **Step 6: Implement bounded download-to-temp and service integration**

In `src/telegram/media.ts`, add:

```ts
export async function downloadAssetToFile(
  client: TelegramLike,
  asset: MediaAsset,
  options: { path: string; maxBytes: number; deadlineMs: number; signal?: AbortSignal },
): Promise<number>;
```

Open the file with exclusive create, write each iterated chunk, and abort/delete
immediately when `maxBytes`, deadline, or signal is exceeded. In
`src/media/service.ts`, select the exact constants above from the effective
mode, create one request-scoped `AbortController`, start its timer immediately
after raw-message resolution, and reject a declared `asset.descriptor.size`
above the selected byte budget before creating a file or requesting the first
Telegram chunk. Otherwise download to a unique file and use the remaining
same deadline for probe, extraction, labelling, and encoding. When metadata has
no duration, call `mediaProcessor.probeDuration` on the completed bounded file;
the default processor runs non-shell FFmpeg with
`-hide_banner -i input -t 0 -f null -`, retains at most 8 KiB of stderr, parses
the single `Duration: HH:MM:SS.sss` field, and rejects missing/non-positive
values as `UNSUPPORTED_MEDIA`. Then normalize explicit or evenly-spaced
timestamps and call `mediaProcessor.contactSheet`. Remove the input file and
clear the timer in `finally`. `auto` catches budget/probe errors and attaches a
thumbnail/original fallback; `frames` returns a structured error.

Add these concrete functions to `productionMediaDependencies`:

```ts
downloadToFile: downloadAssetToFile,
probeDuration: (inputPath, deadline) => mediaProcessor.probeDuration(inputPath, deadline),
contactSheet: (inputPath, request) => mediaProcessor.contactSheet(inputPath, request),
```

- [ ] **Step 7: Trace native binaries into the Vercel function**

```ts
// next.config.ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["ffmpeg-static", "sharp"],
  outputFileTracingIncludes: {
    "/api/mcp": ["./node_modules/ffmpeg-static/ffmpeg"],
  },
};

export default nextConfig;
```

If `ffmpeg-static` exposes a different Linux binary path in the installed version, pin the exact package version and change the tracing glob to that inspected path; never use an unbounded `node_modules/**` include.

- [ ] **Step 8: Run fast and production-build verification**

Run:

```bash
npx vitest run tests/media-processor.test.ts tests/media-service.test.ts
npm test
npm run typecheck
npm run lint
npm run build
du -sh .next/server/app/api/mcp* .next/server/chunks 2>/dev/null
```

Expected: tests/build pass; the traced server output stays below the current
250 MiB uncompressed Node.js function limit documented in
[Vercel Functions limits](https://vercel.com/docs/functions/limitations).

- [ ] **Step 9: Commit, deploy, and measure the processor gate**

```bash
git add src/media/processor.ts src/media/ffmpeg-processor.ts tests/media-processor.test.ts src/media/service.ts src/media/image.ts src/telegram/media.ts next.config.ts package.json package-lock.json
git commit -m "feat: add bounded Telegram video contact sheets"
git push origin main
```

After production deployment, invoke `get_media` on one short MP4, GIF, and video note. Record cold/warm duration, input bytes, output bytes, and deployment bundle size in `docs/media-chatgpt-acceptance.md`. The task passes only when all three produce one labelled image within 25 seconds and 2 MiB. If the deployment or runtime gate fails, stop and revise the approved `MediaProcessor` backend before Task 6; do not raise limits or silently omit frames.

---

### Task 6: Derivative cache, single-flight, concurrency, and safe degradation

**Files:**

- Create: `src/media/cache.ts`
- Create: `tests/media-cache.test.ts`
- Modify: `src/media/service.ts`
- Modify: `src/media/ffmpeg-processor.ts`
- Modify: `src/errors/taxonomy.ts`
- Modify: `src/mcp/tool-result.ts`
- Modify: `src/mcp/logging.ts`
- Modify: `tests/errors.test.ts`
- Modify: `tests/logging.test.ts`
- Modify: `tests/media-service.test.ts`
- Modify: `tests/media-processor.test.ts`

**Interfaces:**

- Consumes: successful derivative files/results from Task 5; no signed outcome may enter this layer.
- Produces:

```ts
export type CachedDerivative = {
  path: string;
  bytes: number;
  mimeType: string;
  width: number;
  height: number;
  frameCount?: number;
  timestampsSeconds?: number[];
};

export class DerivativeCache {
  constructor(options: { maxBytes: number; ttlMs: number; now?: () => number });
  get(key: string): Promise<CachedDerivative | undefined>;
  set(key: string, value: CachedDerivative): Promise<void>;
  clear(): Promise<void>;
}

export function derivativeKey(input: {
  mediaId: string;
  mode: string;
  timestampsSeconds?: number[];
  maxFrames: number;
  processorVersion: string;
}): string;

export function singleFlight<T>(key: string, work: () => Promise<T>): Promise<T>;
export function withVideoPermit<T>(work: () => Promise<T>): Promise<T>;
```

- [ ] **Step 1: Write failing cache, TTL, LRU, and single-flight tests**

```ts
// tests/media-cache.test.ts
it("expires at 30 minutes and deletes the file", async () => {
  let now = 0;
  const cache = new DerivativeCache({ maxBytes: 256, ttlMs: 30 * 60_000, now: () => now });
  const file = await tempFile(100);
  await cache.set("a", derivative(file, 100));
  now = 30 * 60_000 + 1;
  expect(await cache.get("a")).toBeUndefined();
  await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
});

it("evicts least recently used files until the byte total fits", async () => {
  const cache = new DerivativeCache({ maxBytes: 200, ttlMs: 1_000_000 });
  const a = await tempFile(100); const b = await tempFile(100); const c = await tempFile(100);
  await cache.set("a", derivative(a, 100));
  await cache.set("b", derivative(b, 100));
  await cache.get("a");
  await cache.set("c", derivative(c, 100));
  expect(await cache.get("a")).toBeDefined();
  expect(await cache.get("b")).toBeUndefined();
  expect(await cache.get("c")).toBeDefined();
});

it("runs identical work once and different keys independently", async () => {
  const work = vi.fn(async () => 42);
  expect(await Promise.all([singleFlight("x", work), singleFlight("x", work)])).toEqual([42, 42]);
  expect(work).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Implement the file-owning LRU/TTL cache**

Use a `Map<string, { value, expiresAt, lastUsed }>` and one `totalBytes`. `get`
checks expiry and file existence, updates `lastUsed`, and returns a copy. `set`
rejects any single entry larger than the cache ceiling, replaces/deletes an old
same-key file, then repeatedly evicts the smallest `lastUsed` until
`totalBytes <= maxBytes`. All deletes use `fs.rm(path, { force: true })` on the
exact cached file; never recursively delete the temp root.

```ts
import { createHash } from "node:crypto";
import { access, rm } from "node:fs/promises";

type Entry = {
  value: CachedDerivative;
  expiresAt: number;
  lastUsed: number;
};

export class DerivativeCache {
  private readonly entries = new Map<string, Entry>();
  private totalBytes = 0;
  private sequence = 0;

  constructor(private readonly options: {
    maxBytes: number;
    ttlMs: number;
    now?: () => number;
  }) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private async remove(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.totalBytes -= entry.value.bytes;
    await rm(entry.value.path, { force: true });
  }

  async get(key: string): Promise<CachedDerivative | undefined> {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      await this.remove(key);
      return undefined;
    }
    try {
      await access(entry.value.path);
    } catch {
      this.entries.delete(key);
      this.totalBytes -= entry.value.bytes;
      return undefined;
    }
    entry.lastUsed = ++this.sequence;
    return { ...entry.value };
  }

  async set(key: string, value: CachedDerivative): Promise<void> {
    if (value.bytes > this.options.maxBytes) {
      await rm(value.path, { force: true });
      return;
    }
    await this.remove(key);
    this.entries.set(key, {
      value: { ...value },
      expiresAt: this.now() + this.options.ttlMs,
      lastUsed: ++this.sequence,
    });
    this.totalBytes += value.bytes;
    while (this.totalBytes > this.options.maxBytes) {
      const oldest = [...this.entries.entries()]
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0]?.[0];
      if (oldest === undefined) break;
      await this.remove(oldest);
    }
  }

  async clear(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((key) => this.remove(key)));
  }
}

export const derivativeCache = new DerivativeCache({
  maxBytes: 256 * 1024 * 1024,
  ttlMs: 30 * 60_000,
});

export function derivativeKey(input: {
  mediaId: string;
  mode: string;
  timestampsSeconds?: number[];
  maxFrames: number;
  processorVersion: string;
}): string {
  const canonical = JSON.stringify({
    media_id: input.mediaId,
    mode: input.mode,
    timestamps_seconds: input.timestampsSeconds ?? [],
    max_frames: input.maxFrames,
    processor_version: input.processorVersion,
  });
  return createHash("sha256").update(canonical).digest("base64url");
}
```

- [ ] **Step 3: Implement single-flight and a one-slot FIFO video gate**

```ts
const flights = new Map<string, Promise<unknown>>();

export function singleFlight<T>(key: string, work: () => Promise<T>): Promise<T> {
  const existing = flights.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const running = work().finally(() => flights.delete(key));
  flights.set(key, running);
  return running;
}

let videoTail = Promise.resolve();
export async function withVideoPermit<T>(work: () => Promise<T>): Promise<T> {
  const previous = videoTail;
  let release!: () => void;
  videoTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try { return await work(); } finally { release(); }
}
```

Add a test with three deferred promises and assert peak video work is one while image normalization remains immediate.

- [ ] **Step 4: Integrate cache ownership without caching capabilities or originals**

The service computes:

```ts
const key = derivativeKey({
  mediaId: asset.descriptor.media_id,
  mode: effectiveMode,
  timestampsSeconds,
  maxFrames: input.max_frames,
  processorVersion: "contact-sheet-v1",
});
```

Cache only normalized previews/contact sheets. On a hit, read at most 2 MiB
from the exact derivative file and build a fresh `MediaOutcome`. On a miss,
wrap generation in `singleFlight(key, () => withVideoPermit(generate))`, write
the returned bounded derivative buffer to a newly created exact temp file,
call `cache.set` with that file and its measured metadata, and treat ownership
as transferred only after `set` resolves. Delete the file on any pre-transfer
failure. Issue a new original link only after reading the cached derivative.
Add assertions that `mode: original`, direct voice/audio, and outcomes
containing `download.url` never call `cache.set`.

- [ ] **Step 5: Complete stable retryability mappings**

The codes and optional `retryable` field already exist from Task 1. Map
`RATE_LIMITED`, `PROCESSING_TIMEOUT`, and transient
`TELEGRAM_DOWNLOAD_FAILED` to `retryable: true`; `NO_MEDIA`,
`MEDIA_NOT_FOUND`, `UNSUPPORTED_MEDIA`, invalid input, and inline-size fallback
remain false. Add this regression to `tests/errors.test.ts`:

```ts
expect(new GramScopeError("PROCESSING_TIMEOUT", "slow", undefined, true).toStructured())
  .toEqual({ code: "PROCESSING_TIMEOUT", message: "slow", retryable: true });
expect(JSON.stringify(errorResult(new Error("token=secret-value"))))
  .not.toContain("secret-value");
```

- [ ] **Step 6: Add cleanup and logging regressions**

Use injected temp paths and failing writers/processors to test every `finally` branch:

```ts
await expect(generateWith({ processor: async () => { throw new Error("boom"); } })).rejects.toThrow();
await expect(stat(inputPath)).rejects.toMatchObject({ code: "ENOENT" });
expect(JSON.stringify(logLines)).not.toMatch(/token|file_reference|access_hash|secret-file-name/i);
```

Also assert a cache hit logs only `media_kind`, output `bytes`, duration, status, and an optional stable code.

- [ ] **Step 7: Run Task 6 verification**

Run:

```bash
npx vitest run tests/media-cache.test.ts tests/media-service.test.ts tests/media-processor.test.ts tests/errors.test.ts tests/logging.test.ts
npm test
npm run typecheck
npm run lint
npm run build
```

Expected: all pass; temp/cache tests leave no files behind and signed links differ across otherwise identical cache hits.

- [ ] **Step 8: Commit**

```bash
git add src/media/cache.ts tests/media-cache.test.ts src/media/service.ts src/media/ffmpeg-processor.ts src/errors/taxonomy.ts src/mcp/tool-result.ts src/mcp/logging.ts tests/errors.test.ts tests/logging.test.ts tests/media-service.test.ts tests/media-processor.test.ts
git commit -m "feat: bound and harden media processing"
git push origin main
```

---

### Task 7: Live acceptance, ChatGPT evidence, documentation, and release 1.5.0

**Files:**

- Create: `tests/live/media.live.test.ts`
- Modify: `docs/media-chatgpt-acceptance.md`
- Modify: `README.md`
- Modify: `docs/chatgpt-project-instructions.md`
- Modify: `.env.example`
- Modify: `scripts/provision.sh`
- Modify: `src/mcp/version.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tests/mcp-handler.test.ts`
- Modify: `docs/superpowers/tasks/issue-1-media.md`

**Interfaces:**

- Consumes: the complete twenty-tool implementation from Tasks 1–6.
- Produces: repeatable real-account media tests, dated ordinary-ChatGPT evidence, current setup/security docs, and aligned `1.5.0` version metadata.

- [ ] **Step 1: Add an opt-in live media selector contract**

Require explicit test selectors so the suite never guesses messages or downloads arbitrary account media:

```text
GRAMSCOPE_LIVE_MEDIA_SOURCE=
GRAMSCOPE_LIVE_PHOTO_MESSAGE_ID=
GRAMSCOPE_LIVE_IMAGE_DOCUMENT_MESSAGE_ID=
GRAMSCOPE_LIVE_VIDEO_MESSAGE_ID=
GRAMSCOPE_LIVE_OVERSIZED_VIDEO_MESSAGE_ID=
GRAMSCOPE_LIVE_VIDEO_NOTE_MESSAGE_ID=
GRAMSCOPE_LIVE_GIF_MESSAGE_ID=
GRAMSCOPE_LIVE_VOICE_MESSAGE_ID=
GRAMSCOPE_LIVE_LARGE_VOICE_MESSAGE_ID=
GRAMSCOPE_LIVE_AUDIO_MESSAGE_ID=
GRAMSCOPE_LIVE_DOCUMENT_MESSAGE_ID=
GRAMSCOPE_LIVE_STICKER_MESSAGE_ID=
```

In `tests/live/media.live.test.ts`, skip unless `GRAMSCOPE_LIVE === "1"` and all required selectors exist. Parse message ids as positive safe integers and fail with the missing variable's name.

- [ ] **Step 2: Write the real Telegram acceptance tests**

```ts
const live = process.env.GRAMSCOPE_LIVE === "1" ? describe : describe.skip;

live("Telegram media", () => {
  it("returns one bounded photo artifact without a follow-up", async () => {
    const outcome = await getMedia(liveInput("PHOTO"));
    expect(outcome.result.status).toBe("ready");
    expect(outcome.artifact?.type).toBe("image");
    expect(outcome.artifact!.data.length).toBeLessThanOrEqual(INLINE_MEDIA_MAX_BYTES);
  });

  it.each(["VIDEO", "VIDEO_NOTE", "GIF"])("builds one labelled sheet for %s", async (kind) => {
    const started = Date.now();
    const outcome = await getMedia(liveInput(kind));
    expect(outcome.artifact?.type).toBe("image");
    expect(outcome.result.representation?.frame_count).toBe(8);
    expect(Date.now() - started).toBeLessThan(25_000);
  });

  it("preserves voice bytes and metadata", async () => {
    const outcome = await getMedia(liveInput("VOICE"));
    expect(outcome.result.media?.type).toBe("voice");
    expect(outcome.result.representation?.file_name)
      .toMatch(/^(voice-\d+\.[A-Za-z0-9]+|[^/]+\.[A-Za-z0-9]+)$/);
    expect(outcome.result.representation?.mime_type).toBeTruthy();
  });
});
```

Add tests for music audio, generic document thumbnail/link, an exact-timestamp contact sheet, a full original, `bytes=0-1048575`, tampered token, expired token through injected clock, and abort. Save no media fixture in Git and print no URL/token.

- [ ] **Step 3: Run the full local quality gate**

Run:

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run test:live
```

Expected: every fast/build/live command passes. If Telegram rate-limits, record the returned retry duration, wait outside the test process, and rerun once; do not weaken assertions or add automatic long sleeps.

- [ ] **Step 4: Run deployed Vercel acceptance**

After pushing the live-test commit to a preview or production deployment:

- call bounded photo, voice, video, GIF, and video-note examples through the deployed MCP endpoint;
- download one large original fully and with a one-MiB Range;
- abort one download and confirm Telegram iteration stops;
- inspect function size/cold-start/duration and confirm 25/45-second limits;
- inspect application/platform logs and confirm no signed URL, JWE, filename, media bytes, `file_reference`, or `access_hash` is retained.

If platform access logging exposes the capability URL, apply the hard
release-blocker branch defined in Task 4 Step 10. The release cannot proceed on
the direct route, and it cannot silently substitute an unspecified storage
provider.

- [ ] **Step 5: Run ordinary ChatGPT Project-chat acceptance**

Refresh the custom app's actions, select it for each acceptance message, and use real selectors:

Before sending, replace the `GRAMSCOPE_LIVE_*` names below with their actual
non-secret source/message values from `.env.local`.

```text
Inspect the Telegram photo identified by GRAMSCOPE_LIVE_MEDIA_SOURCE and GRAMSCOPE_LIVE_PHOTO_MESSAGE_ID in the acceptance setup, and describe what is visible.
Inspect the Telegram video identified by GRAMSCOPE_LIVE_MEDIA_SOURCE and GRAMSCOPE_LIVE_VIDEO_MESSAGE_ID in the acceptance setup, and summarize only what the returned frames establish.
Inspect the Telegram voice message identified by GRAMSCOPE_LIVE_MEDIA_SOURCE and GRAMSCOPE_LIVE_VOICE_MESSAGE_ID in the acceptance setup. Tell me whether usable audio was delivered; do not infer content from filename or metadata.
```

For each, record in `docs/media-chatgpt-acceptance.md`: date, ChatGPT surface/plan, exact tool calls, returned MCP content types, first/warm latency, whether the model used the artifact, and fallback if any. Acceptance requires exactly one `get_media` call for bounded photo/video/audio. If neither direct audio nor same-call resource link is model-consumable, record that client limitation and verify the original link remains usable; do not add transcription.

- [ ] **Step 6: Update model-facing and operator documentation**

In `docs/chatgpt-project-instructions.md`, add this concise rule under `How to act`:

```markdown
- When a message's attached media may affect the answer, call `get_media` with
  its `source_id` and `message_id`. Normally omit `mode`: GramScope chooses one
  bounded image/audio representation. Use `original` only when the user asks
  for the source file or the automatic representation is insufficient.
```

In `README.md`, change the headline to version 1.5.0/20 tools, add `get_media` under reading, document `MEDIA_TOKEN_SECRET`, the 2 MiB inline cap, expiring original links, FFmpeg/temporary-storage behaviour, no transcription, and the need to refresh ChatGPT actions after deployment.

- [ ] **Step 7: Align version and tool-count assertions**

Set:

```ts
// src/mcp/version.ts
export const MCP_SERVER_VERSION = "1.5.0";
```

Run `npm version 1.5.0 --no-git-tag-version` to update both package files. Change `tests/mcp-handler.test.ts` to assert `1.5.0` in all three locations and rename all nineteen-tool descriptions/assertions to twenty. Run:

```bash
npx vitest run tests/tools.test.ts tests/mcp-handler.test.ts
npm test
npm run typecheck
npm run lint
npm run build
```

Expected: PASS and `tools/list` names exactly twenty tools.

- [ ] **Step 8: Update the task card with measured facts and close open questions**

In `docs/superpowers/tasks/issue-1-media.md`, replace each open checkbox with its measured result:

- direct `ImageContent`/`AudioContent`/`resource_link` behaviour in ordinary ChatGPT;
- selected FFmpeg backend, deployed bundle size, cold/warm latency, and sample duration;
- Vercel direct streaming result or chosen private staging backend;
- links to `docs/media-chatgpt-acceptance.md`, this plan, and the implementation commits.

Do not rewrite earlier dated decisions; mark superseded findings explicitly.

- [ ] **Step 9: Commit and push the release**

```bash
git add tests/live/media.live.test.ts docs/media-chatgpt-acceptance.md README.md docs/chatgpt-project-instructions.md .env.example scripts/provision.sh src/mcp/version.ts package.json package-lock.json tests/mcp-handler.test.ts docs/superpowers/tasks/issue-1-media.md
git commit -m "release: GramScope 1.5.0 media inspection"
git push origin main
```

Wait for production deployment, refresh the ChatGPT app one last time, rerun one bounded photo and one original Range smoke test, and capture the successful deployment/acceptance links in the task card.

---
