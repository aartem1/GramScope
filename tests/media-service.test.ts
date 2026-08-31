import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getMediaInputSchema,
  INLINE_MEDIA_MAX_BYTES,
} from "@/schemas/media";
import { mediaToolResult } from "@/mcp/media-result";
import { runGetMediaTool } from "@/mcp/tools/get-media";
import {
  AUTO_VIDEO_DEADLINE_MS,
  AUTO_VIDEO_MAX_BYTES,
  attachOriginalLink,
  FRAMES_VIDEO_DEADLINE_MS,
  FRAMES_VIDEO_MAX_BYTES,
  getMedia,
  type MediaAsset,
  type MediaDependencies,
} from "@/media/service";
import {
  downloadAssetToFile,
  iterAssetBytes,
  readAssetBytes,
  resolveMediaAsset,
} from "@/telegram/media";
import { mapMessage } from "@/schemas/message";
import { normalizeImage } from "@/media/image";
import { mediaError } from "@/errors/taxonomy";
import type { ContactSheetRequest } from "@/media/processor";
import type { TelegramLike } from "@/telegram/client";
import type { GetMediaInput, MediaDescriptor } from "@/schemas/media";
import sharp from "sharp";

const telegramMocks = vi.hoisted(() => ({
  fetchDialogIndex: vi.fn(async () => ({ byId: new Map(), folders: [] })),
  resolveSource: vi.fn(async (_client: unknown, _index: unknown, sourceId: string) => ({
    source_id: "-1001",
    title: "News",
    handle: sourceId === "@news" ? "@news" : "-1001",
  })),
}));

vi.mock("@/telegram/dialog-index", () => ({
  fetchDialogIndex: telegramMocks.fetchDialogIndex,
}));
vi.mock("@/telegram/peer-resolve", () => ({
  resolveSource: telegramMocks.resolveSource,
}));

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

  it("rejects original mode when timestamps imply frames", () => {
    expect(() => getMediaInputSchema.parse({
      source_id: "-1001",
      message_id: 7,
      mode: "original",
      timestamps_seconds: [1],
    })).toThrow();
  });

  it("keeps binary out of structuredContent", () => {
    const bytes = Buffer.from("image-bytes");
    const result = mediaToolResult({
      result: {
        status: "ready",
        source_id: "-1001",
        message_id: 7,
        representation: {
          kind: "image",
          mime_type: "image/jpeg",
          byte_size: bytes.length,
        },
      },
      artifact: { type: "image", data: bytes, mimeType: "image/jpeg" },
    });
    expect(result.content.map((part) => part.type)).toEqual(["text", "image"]);
    expect(JSON.stringify(result.structuredContent)).not.toContain(bytes.toString("base64"));
    expect(bytes.length).toBeLessThan(INLINE_MEDIA_MAX_BYTES);
  });
});

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

function documentMessage(input: {
  id: number;
  documentId: bigint;
  attributes: readonly Record<string, unknown>[];
}) {
  return {
    className: "Message",
    id: input.id,
    media: {
      className: "MessageMediaDocument",
      document: {
        className: "Document",
        id: input.documentId,
        mimeType: "video/mp4",
        size: 5000n,
        attributes: input.attributes,
      },
    },
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
    normalizeImage: async (data, sourceOptions) => ({
      data,
      mimeType: (sourceOptions?.sourceMimeType ?? "image/jpeg") as "image/jpeg",
      width: 1,
      height: 1,
    }),
    attachOriginalLink: async (_asset, outcome) => outcome,
  };
}

function fakeVideoDeps() {
  const base = fakeMediaDeps({
    asset: fakeAsset({
      type: "video",
      mime_type: "video/mp4",
      size: 10_000,
      duration_seconds: 90,
    }),
  });
  return {
    ...base,
    downloadToFile: vi.fn(async () => 10_000),
    probeDuration: vi.fn(async (path: string, deadline: AbortSignal) => {
      void path;
      void deadline;
      return 90;
    }),
    contactSheet: vi.fn(async (_path: string, request: ContactSheetRequest) => ({
      data: Buffer.from("jpeg"),
      mimeType: "image/jpeg" as const,
      width: 1200,
      height: 800,
      frameCount: request.timestampsSeconds.length,
      timestampsSeconds: request.timestampsSeconds,
    })),
    attachOriginalLink: vi.fn(async (_asset: MediaAsset, outcome: Awaited<ReturnType<typeof getMedia>>) => ({
      ...outcome,
      result: {
        ...outcome.result,
        download: {
          url: "https://gramscope.test/api/media/test",
          expires_at: "2026-08-30T12:10:00.000Z",
        },
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

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  telegramMocks.fetchDialogIndex.mockClear();
  telegramMocks.resolveSource.mockClear();
});

describe("Telegram media bytes", () => {
  it("streams a bounded asset to an exclusively created file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gramscope-download-test-"));
    const outputPath = join(directory, "asset.bin");
    const client = fakeMediaClient({
      iterDownload: async function* () {
        yield Buffer.from("ab");
        yield Buffer.from("cde");
      },
    });
    try {
      await expect(downloadAssetToFile(client, fakeAsset({ size: 5 }), {
        path: outputPath,
        maxBytes: 5,
        deadlineMs: 1_000,
      })).resolves.toBe(5);
      expect(await readFile(outputPath, "utf8")).toBe("abcde");
      await expect(downloadAssetToFile(client, fakeAsset({ size: 5 }), {
        path: outputPath,
        maxBytes: 5,
        deadlineMs: 1_000,
      })).rejects.toMatchObject({ code: "TELEGRAM_DOWNLOAD_FAILED" });
      expect(await readFile(outputPath, "utf8")).toBe("abcde");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("deletes a partial file immediately when the video byte cap is exceeded", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gramscope-download-test-"));
    const outputPath = join(directory, "asset.bin");
    const client = fakeMediaClient({
      iterDownload: async function* () {
        yield Buffer.from("abcd");
        yield Buffer.from("ef");
      },
    });
    try {
      await expect(downloadAssetToFile(client, fakeAsset({ size: undefined }), {
        path: outputPath,
        maxBytes: 5,
        deadlineMs: 1_000,
      })).rejects.toMatchObject({ code: "INLINE_LIMIT_EXCEEDED" });
      await expect(access(outputPath)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not create a destination for an already-aborted download", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gramscope-download-test-"));
    const outputPath = join(directory, "asset.bin");
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(downloadAssetToFile(fakeMediaClient(), fakeAsset(), {
        path: outputPath,
        maxBytes: 5,
        deadlineMs: 1_000,
        signal: controller.signal,
      })).rejects.toMatchObject({ code: "PROCESSING_TIMEOUT" });
      await expect(access(outputPath)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("interrupts a stalled Telegram iterator and deletes the partial file on abort", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gramscope-download-test-"));
    const outputPath = join(directory, "asset.bin");
    const controller = new AbortController();
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => { release = resolve; });
    const client = fakeMediaClient({
      iterDownload: async function* () {
        yield Buffer.from("a");
        await stalled;
        yield Buffer.from("b");
      },
    });
    try {
      const download = downloadAssetToFile(client, fakeAsset({ size: 2 }), {
        path: outputPath,
        maxBytes: 2,
        deadlineMs: 1_000,
        signal: controller.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort();
      const result = await Promise.race([
        download.then(() => "resolved", () => "rejected"),
        new Promise<string>((resolve) => setTimeout(() => resolve("stalled"), 75)),
      ]);
      expect(result).toBe("rejected");
      await expect(access(outputPath)).rejects.toThrow();
      release();
      await download.catch(() => undefined);
    } finally {
      release();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["video", [{ className: "DocumentAttributeVideo", w: 1280, h: 720, duration: 4 }]],
    ["gif", [
      { className: "DocumentAttributeAnimated" },
      { className: "DocumentAttributeVideo", w: 1280, h: 720, duration: 4 },
    ]],
    ["sticker", [
      { className: "DocumentAttributeSticker" },
      { className: "DocumentAttributeImageSize", w: 512, h: 512 },
    ]],
    ["video_note", [{
      className: "DocumentAttributeVideo",
      roundMessage: true,
      w: 480,
      h: 480,
      duration: 12,
    }]],
  ] as const)("keeps %s identity identical in read and media-resolver paths", async (type, attributes) => {
    const raw = documentMessage({ id: 7, documentId: 99n, attributes });
    const client = fakeMediaClient({ getMessages: async () => [raw] });

    const read = mapMessage(raw, { chatId: "-1001" }).media;
    const asset = await resolveMediaAsset(client, { sourceId: "@news", messageId: 7 });

    expect(read).toMatchObject({ type });
    expect(asset.descriptor).toMatchObject({
      type: read?.type,
      media_id: read?.media_id,
    });
  });

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
});

describe("getMedia", () => {
  it("auto uses eight frames and the 64 MiB/25 second budget", async () => {
    const deps = fakeVideoDeps();
    await getMedia(input(), deps);

    expect(deps.contactSheet).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      timestampsSeconds: [10, 20, 30, 40, 50, 60, 70, 80],
    }));
    expect(deps.downloadToFile).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      path: expect.any(String),
      maxBytes: AUTO_VIDEO_MAX_BYTES,
      deadlineMs: AUTO_VIDEO_DEADLINE_MS,
      signal: expect.any(AbortSignal),
    });
  });

  it("explicit timestamps are sorted and returned on one artifact", async () => {
    const outcome = await getMedia(input({
      timestamps_seconds: [8, 1, 5],
    }), fakeVideoDeps());

    expect(outcome.result.representation?.timestamps_seconds).toEqual([1, 5, 8]);
    expect(outcome.result.representation?.frame_count).toBe(3);
    expect(outcome.artifact?.type).toBe("image");
  });

  it("rejects duplicate millisecond timestamps as invalid input", async () => {
    await expect(getMedia(input({
      timestamps_seconds: [1.0001, 1.0004],
    }), fakeVideoDeps())).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("explicit frames uses the 128 MiB/45 second budget", async () => {
    const deps = fakeVideoDeps();
    await getMedia(input({ mode: "frames" }), deps);

    expect(deps.downloadToFile).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      path: expect.any(String),
      maxBytes: FRAMES_VIDEO_MAX_BYTES,
      deadlineMs: FRAMES_VIDEO_DEADLINE_MS,
      signal: expect.any(AbortSignal),
    });
  });

  it("probes a missing duration within the same deadline before spacing frames", async () => {
    const deps = fakeVideoDeps();
    deps.resolveAsset = vi.fn(async () => fakeAsset({
      type: "video",
      mime_type: "video/mp4",
      size: 10_000,
      duration_seconds: undefined,
    }));
    await getMedia(input(), deps);

    expect(deps.probeDuration).toHaveBeenCalledOnce();
    const probeSignal = deps.probeDuration.mock.calls[0]?.[1];
    const sheetSignal = deps.contactSheet.mock.calls[0]?.[1].deadline;
    expect(probeSignal).toBe(sheetSignal);
    expect(deps.contactSheet).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      timestampsSeconds: [10, 20, 30, 40, 50, 60, 70, 80],
    }));
  });

  it("auto timeout returns thumbnail plus original link; explicit frames errors", async () => {
    const auto = await getMedia(input(), fakeTimedOutVideoDeps({ thumbnail: true }));
    expect(auto.result).toMatchObject({ status: "fallback", code: "PROCESSING_TIMEOUT" });
    expect(auto.artifact?.type).toBe("image");
    expect(auto.link).toBeDefined();

    const frames = await getMedia(
      input({ mode: "frames" }),
      fakeTimedOutVideoDeps({ thumbnail: true }),
    );
    expect(frames.result).toMatchObject({ status: "error", code: "PROCESSING_TIMEOUT" });
  });

  it("rejects a declared oversized video before creating a file or requesting a chunk", async () => {
    const deps = fakeVideoDeps();
    deps.resolveAsset = vi.fn(async () => fakeAsset({
      type: "video",
      mime_type: "video/mp4",
      size: AUTO_VIDEO_MAX_BYTES + 1,
      duration_seconds: 90,
    }));

    const outcome = await getMedia(input(), deps);
    expect(outcome.result).toMatchObject({ status: "fallback", code: "INLINE_LIMIT_EXCEEDED" });
    expect(outcome.link).toBeDefined();
    expect(deps.downloadToFile).not.toHaveBeenCalled();
    expect(deps.contactSheet).not.toHaveBeenCalled();
  });

  it("issues an encrypted same-origin original link from the stable selector", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00Z"));
    const key = Buffer.alloc(32, 7).toString("base64url");
    const environment = {
      TELEGRAM_API_ID: "12345",
      TELEGRAM_API_HASH: "hash",
      TELEGRAM_SESSION: "session",
      WORKOS_ISSUER: "https://auth.example.test",
      WORKOS_JWKS_URL: "https://auth.example.test/jwks",
      OWNER_USER_ID: "owner-1",
      MCP_RESOURCE_URL: "https://gramscope.test/api/mcp",
      MEDIA_TOKEN_SECRET: key,
    };
    for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value);
    const asset = fakeAsset({
      type: "document",
      file_name: "report.pdf",
      mime_type: "application/pdf",
      size: 123,
    });
    const outcome = await attachOriginalLink(asset, {
      result: {
        status: "fallback",
        source_id: asset.sourceId,
        message_id: asset.messageId,
        media: asset.descriptor,
        representation: { kind: "metadata" },
        code: "UNSUPPORTED_MEDIA",
        retryable: false,
        message: "fallback",
      },
    });

    expect(outcome.result.download?.expires_at).toBe("2026-08-30T12:10:00.000Z");
    expect(outcome.link).toMatchObject({
      name: "report.pdf",
      mimeType: "application/pdf",
      size: 123,
    });
    const link = new URL(outcome.link!.uri);
    expect(link.origin).toBe("https://gramscope.test");
    expect(link.pathname).toMatch(/^\/api\/media\/[^/]+$/);
    expect(link.pathname).not.toContain(asset.sourceId);
  });

  it("returns a direct image for a bounded photo", async () => {
    const deps = fakeMediaDeps();

    await expect(getMedia(input(), deps)).resolves.toMatchObject({
      result: { status: "ready", representation: { kind: "image", byte_size: 5 } },
      artifact: { type: "image", data: Buffer.from("abcde"), mimeType: "image/jpeg" },
    });
  });

  it("logs only the safe media summary fields", async () => {
    const lines: string[] = [];
    await runGetMediaTool(
      input(),
      async () => ({
        result: {
          status: "ready",
          source_id: "-1001",
          message_id: 7,
          media: {
            media_id: "med_test",
            type: "photo",
            size: 5,
          },
          representation: { kind: "image", byte_size: 5 },
        },
      }),
      (line) => lines.push(line),
    );

    expect(lines).toEqual([expect.stringContaining("media_kind=photo")]);
    expect(lines[0]).toContain("bytes=5");
    expect(lines[0]).not.toContain("-1001");
  });

  it("returns a direct audio artifact for a bounded voice message", async () => {
    const deps = fakeMediaDeps({
      asset: fakeAsset({ type: "voice", mime_type: "audio/ogg" }),
    });

    await expect(getMedia(input(), deps)).resolves.toMatchObject({
      result: { status: "ready", representation: { kind: "audio" } },
      artifact: { type: "audio", mimeType: "audio/ogg" },
    });
  });

  it("adds one same-call original link to one bounded source-audio block", async () => {
    const bytes = Buffer.from("source-ogg");
    const deps = fakeMediaDeps({
      asset: fakeAsset({
        type: "voice",
        mime_type: "audio/ogg",
        file_name: "voice.ogg",
        size: bytes.length,
      }),
      bytes,
    });
    deps.attachOriginalLink = async (_asset, outcome) => ({
      ...outcome,
      result: {
        ...outcome.result,
        download: {
          url: "https://gramscope.test/api/media/encrypted",
          expires_at: "2026-08-30T12:10:00.000Z",
        },
      },
      link: {
        uri: "https://gramscope.test/api/media/encrypted",
        name: "voice.ogg",
        mimeType: "audio/ogg",
        size: bytes.length,
      },
    });

    const outcome = await getMedia(input(), deps);
    const toolResult = mediaToolResult(outcome);
    expect(toolResult.content.filter((part) => part.type === "audio")).toHaveLength(1);
    expect(toolResult.content.filter((part) => part.type === "resource_link")).toEqual([{
      type: "resource_link",
      uri: "https://gramscope.test/api/media/encrypted",
      name: "voice.ogg",
      mimeType: "audio/ogg",
      size: bytes.length,
    }]);
    expect(outcome.artifact).toMatchObject({ type: "audio", mimeType: "audio/ogg" });
    expect(outcome.artifact?.data.equals(bytes)).toBe(true);
  });

  it.each([
    ["voice", "explicit frames", { mode: "frames" }],
    ["voice", "timestamps", { timestamps_seconds: [1] as number[] }],
    ["audio", "explicit frames", { mode: "frames" }],
    ["audio", "timestamps", { timestamps_seconds: [1] as number[] }],
  ] as const)(
    "adds exactly one original link to %s rejected by %s representation",
    async (type, _case, inputOverrides) => {
      const deps = fakeMediaDeps({
        asset: fakeAsset({ type, mime_type: "audio/ogg", size: 128 }),
      });
      deps.attachOriginalLink = async (_asset, outcome) => ({
        ...outcome,
        result: {
          ...outcome.result,
          download: {
            url: "https://gramscope.test/api/media/encrypted",
            expires_at: "2026-08-30T12:10:00.000Z",
          },
        },
        link: {
          uri: "https://gramscope.test/api/media/encrypted",
          name: `${type}-7.ogg`,
          mimeType: "audio/ogg",
          size: 128,
        },
      });

      const outcome = await getMedia(input(inputOverrides), deps);
      const content = mediaToolResult(outcome).content;
      expect(outcome.result).toMatchObject({
        status: "error",
        code: "UNSUPPORTED_MEDIA",
        representation: { kind: "metadata" },
      });
      expect(content.filter((part) => part.type === "resource_link")).toHaveLength(1);
      expect(content.filter((part) => part.type === "audio" || part.type === "image"))
        .toHaveLength(0);
      expect(deps.readBytes).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["photo", "image/jpeg", "image"],
    ["document", "image/png", "image"],
    ["voice", "audio/ogg", "audio"],
    ["audio", "audio/mpeg", "audio"],
  ] as const)("auto returns one direct artifact for %s", async (type, mimeType, expectedType) => {
    const outcome = await getMedia(
      input(),
      fakeMediaDeps({ asset: fakeAsset({ type, mime_type: mimeType, size: 128 }), bytes: Buffer.alloc(128) }),
    );
    expect(outcome.result.status).toBe("ready");
    expect(outcome.artifact?.type).toBe(expectedType);
    expect(outcome.result.representation?.file_name).toBeTruthy();
  });

  it("does not download audio declared above the inline cap", async () => {
    const deps = fakeMediaDeps({
      asset: fakeAsset({ type: "voice", size: INLINE_MEDIA_MAX_BYTES + 1 }),
    });
    const outcome = await getMedia(input(), deps);
    expect(deps.readBytes).not.toHaveBeenCalled();
    expect(outcome.result).toMatchObject({ status: "fallback", code: "INLINE_LIMIT_EXCEEDED" });
  });

  it("classifies unsupported oversized media before considering its size", async () => {
    const deps = fakeMediaDeps({
      asset: fakeAsset({ type: "archive", size: INLINE_MEDIA_MAX_BYTES + 1 }),
    });
    const outcome = await getMedia(input(), deps);
    expect(deps.readBytes).not.toHaveBeenCalled();
    expect(outcome.result).toMatchObject({ status: "error", code: "UNSUPPORTED_MEDIA" });
  });

  it("preserves bounded source audio bytes exactly", async () => {
    const bytes = Buffer.from([0x4f, 0x67, 0x67, 0x53, 0, 0xff, 0x10]);
    const outcome = await getMedia(
      input(),
      fakeMediaDeps({
        asset: fakeAsset({ type: "voice", mime_type: "audio/ogg", size: bytes.length }),
        bytes,
      }),
    );
    expect(outcome.artifact?.data.equals(bytes)).toBe(true);
    expect(outcome.artifact?.mimeType).toBe("audio/ogg");
  });

  it("falls back when original-mode audio exceeds the measured limit", async () => {
    const deps = fakeMediaDeps({
      asset: fakeAsset({ type: "voice", mime_type: "audio/ogg", size: 128 }),
    });
    deps.readBytes.mockRejectedValue(mediaError(
      "INLINE_LIMIT_EXCEEDED",
      "Media exceeds the inline media limit",
    ));

    await expect(getMedia(input({ mode: "original" }), deps)).resolves.toMatchObject({
      result: { status: "fallback", code: "INLINE_LIMIT_EXCEEDED" },
    });
  });

  it("classifies unsupported original-mode media before the size fallback", async () => {
    const deps = fakeMediaDeps({
      asset: fakeAsset({ type: "archive", size: 128 }),
      bytes: Buffer.alloc(128),
    });
    deps.attachOriginalLink = async (_asset, outcome) => ({
      ...outcome,
      link: { uri: "https://example.test/original", name: "original" },
    });

    await expect(getMedia(input({ mode: "original" }), deps)).resolves.toMatchObject({
      result: { status: "error", code: "UNSUPPORTED_MEDIA" },
      link: { uri: "https://example.test/original" },
    });
    expect(deps.readBytes).not.toHaveBeenCalled();
  });

  it("normalizes a large thumbnail before emitting it as an image", async () => {
    const thumbnailData = await sharp({
      create: { width: 2400, height: 1800, channels: 3, background: "#cc3311" },
    }).jpeg({ quality: 100 }).toBuffer();
    const deps = fakeMediaDeps({ asset: fakeAsset({ type: "video", mime_type: "video/mp4" }) });
    deps.readThumbnail = async () => ({
      type: "image",
      data: thumbnailData,
      mimeType: "image/jpeg",
    });
    deps.normalizeImage = normalizeImage;

    const outcome = await getMedia(input(), deps);
    expect(outcome.artifact).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    expect(outcome.result.representation).toMatchObject({ width: 1600, height: 1200 });
    expect(outcome.result.representation).toMatchObject({
      kind: "image",
      mime_type: "image/jpeg",
      byte_size: outcome.artifact?.data.length,
    });
    expect(outcome.artifact?.data.length).toBeLessThanOrEqual(INLINE_MEDIA_MAX_BYTES);
  });

  it("uses the emitted image MIME for the direct artifact filename", async () => {
    const deps = fakeMediaDeps({
      asset: fakeAsset({
        type: "document",
        mime_type: "image/png",
        file_name: "cover.png",
        size: 128,
      }),
      bytes: Buffer.alloc(128),
    });
    deps.normalizeImage = async (data) => ({
      data,
      mimeType: "image/jpeg",
      width: 320,
      height: 180,
    });

    await expect(getMedia(input(), deps)).resolves.toMatchObject({
      result: { representation: { file_name: "cover.jpg", mime_type: "image/jpeg" } },
    });
  });

  it("returns metadata-only fallback before downloading oversized media", async () => {
    const deps = fakeMediaDeps({
      asset: fakeAsset({ size: INLINE_MEDIA_MAX_BYTES + 1 }),
    });

    await expect(getMedia(input(), deps)).resolves.toMatchObject({
      result: {
        status: "fallback",
        representation: { kind: "metadata" },
        code: "INLINE_LIMIT_EXCEEDED",
      },
    });
    expect(deps.readBytes).not.toHaveBeenCalled();
  });

  it("does not serialize Telegram transport fields", async () => {
    const asset = fakeAsset();
    asset.rawMessage.fileReference = "MESSAGE_REFERENCE_SENTINEL";
    asset.rawMedia.accessHash = "MEDIA_ACCESS_HASH_SENTINEL";
    asset.thumbnailLocation = "THUMBNAIL_LOCATION_SENTINEL";
    const deps = fakeMediaDeps({ asset });

    const outcome = await getMedia(input(), deps);
    expect(JSON.stringify(outcome)).not.toContain("MESSAGE_REFERENCE_SENTINEL");
    expect(JSON.stringify(outcome)).not.toContain("MEDIA_ACCESS_HASH_SENTINEL");
    expect(JSON.stringify(outcome)).not.toContain("THUMBNAIL_LOCATION_SENTINEL");
  });
});
