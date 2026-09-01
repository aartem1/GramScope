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
  attachOriginalLink,
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
import { mediaError } from "@/errors/taxonomy";
import { DerivativeCache } from "@/media/cache";
import type { TelegramLike } from "@/telegram/client";
import type { GetMediaInput, MediaDescriptor } from "@/schemas/media";

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

function photoMessage(input: { id: number; bytes: number; photoId?: unknown }) {
  return {
    className: "Message",
    id: input.id,
    media: {
      className: "MessageMediaPhoto",
      photo: { className: "Photo", id: input.photoId ?? 11n, sizes: [], dcId: 2 },
    },
    expectedBytes: input.bytes,
  };
}

function sizedPhotoMessage(
  id: number,
  sizes: readonly Record<string, unknown>[],
) {
  return {
    className: "Message",
    id,
    media: {
      className: "MessageMediaPhoto",
      photo: {
        className: "Photo",
        flags: 0,
        hasStickers: false,
        id: 11n,
        accessHash: 22n,
        fileReference: Buffer.from([1, 2, 3]),
        date: 1_777_593_600,
        sizes,
        videoSizes: [],
        dcId: 2,
      },
    },
  };
}

function documentMessage(input: {
  id: number;
  documentId: unknown;
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
    derivativeCache: undefined,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  telegramMocks.fetchDialogIndex.mockClear();
  telegramMocks.resolveSource.mockClear();
});

describe("Telegram media bytes", () => {
  it.each([
    [
      "photo",
      photoMessage({ id: 7, bytes: 5, photoId: { value: 11n } }),
      "photo",
      "med_cTbYHpiy92mv4vHlI6lFWYUkxvIIbb9juDw3BNEPQK0",
    ],
    [
      "document",
      documentMessage({
        id: 7,
        documentId: { value: 99n },
        attributes: [{ className: "DocumentAttributeVideo", w: 1280, h: 720, duration: 4 }],
      }),
      "video",
      "med_jGtpofbTHnNa1GeFWIAEYDdZwwPEzj8DZPs3HWdTFWA",
    ],
  ])("resolves a teleproto BigInteger-like %s id", async (_name, raw, type, expectedMediaId) => {
    const client = fakeMediaClient({ getMessages: async () => [raw] });

    await expect(resolveMediaAsset(client, { sourceId: "@news", messageId: 7 }))
      .resolves.toMatchObject({
        descriptor: {
          type,
          media_id: expectedMediaId,
        },
      });
  });

  it.each([
    ["photo", photoMessage({ id: 7, bytes: 5, photoId: "" })],
    ["document", documentMessage({
      id: 7,
      documentId: Number.NaN,
      attributes: [{ className: "DocumentAttributeVideo", w: 1280, h: 720, duration: 4 }],
    })],
  ])("rejects a malformed %s id without creating a stable media identity", async (_name, raw) => {
    const client = fakeMediaClient({ getMessages: async () => [raw] });

    const outcome = await resolveMediaAsset(client, { sourceId: "@news", messageId: 7 })
      .catch((error: unknown) => error);

    expect(outcome).toMatchObject({ code: "NO_MEDIA" });
    expect(outcome).not.toHaveProperty("descriptor.media_id");
  });

  it("uses the final progressive photo byte size when resolving the downloadable photo", async () => {
    const raw = {
      className: "Message",
      id: 7,
      media: {
        className: "MessageMediaPhoto",
        photo: {
          className: "Photo",
          flags: 0,
          hasStickers: false,
          id: 11n,
          accessHash: 22n,
          fileReference: Buffer.from([1, 2, 3]),
          date: 1_777_593_600,
          sizes: [
            {
              className: "PhotoSize",
              type: "x",
              w: 800,
              h: 640,
              size: 104_757,
            },
            {
              className: "PhotoSizeProgressive",
              type: "y",
              w: 1280,
              h: 1024,
              sizes: [21_978, 60_772, 87_261, 144_257, 171_114],
            },
          ],
          videoSizes: [],
          dcId: 2,
        },
      },
    };
    const client = fakeMediaClient({ getMessages: async () => [raw] });

    const asset = await resolveMediaAsset(client, { sourceId: "@news", messageId: 7 });

    expect(asset.descriptor).toMatchObject({
      type: "photo",
      mime_type: "image/jpeg",
      size: 171_114,
      width: 1280,
      height: 1024,
    });
  });

  it.each([
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
    ["fractional", 171_114.5],
    ["zero", 0],
    ["negative", -1],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
  ])("ignores a malformed %s photo byte size in scalar and progressive fields", async (_name, malformed) => {
    const progressiveRaw = sizedPhotoMessage(7, [
      { className: "PhotoSize", type: "x", w: 800, h: 640, size: 104_757 },
      {
        className: "PhotoSizeProgressive",
        type: "y",
        w: 1280,
        h: 1024,
        sizes: [120_000, malformed, 171_114],
      },
    ]);
    const scalarRaw = sizedPhotoMessage(8, [
      { className: "PhotoSize", type: "z", w: 1600, h: 1280, size: malformed },
      {
        className: "PhotoSizeProgressive",
        type: "y",
        w: 1280,
        h: 1024,
        sizes: [120_000, 171_114],
      },
    ]);

    const progressiveAsset = await resolveMediaAsset(
      fakeMediaClient({ getMessages: async () => [progressiveRaw] }),
      { sourceId: "@news", messageId: 7 },
    );
    const scalarAsset = await resolveMediaAsset(
      fakeMediaClient({ getMessages: async () => [scalarRaw] }),
      { sourceId: "@news", messageId: 8 },
    );

    expect(progressiveAsset.descriptor).toMatchObject({
      size: 171_114,
      width: 1280,
      height: 1024,
    });
    expect(scalarAsset.descriptor).toMatchObject({
      size: 171_114,
      width: 1280,
      height: 1024,
    });
  });

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
    const stalled = new Promise<IteratorResult<Buffer>>((resolve) => {
      release = () => resolve({ done: false, value: Buffer.from("b") });
    });
    let calls = 0;
    const upstream = {
      next: vi.fn(() => {
        calls += 1;
        return calls === 1
          ? Promise.resolve({ done: false as const, value: Buffer.from("a") })
          : stalled;
      }),
      return: vi.fn(async () => ({ done: true as const, value: undefined })),
      [Symbol.asyncIterator]() { return this; },
    };
    const client = fakeMediaClient({
      iterDownload: vi.fn(() => upstream as unknown as AsyncGenerator<Buffer, void, unknown>),
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
      expect(upstream.return).toHaveBeenCalledOnce();
      expect(client.iterDownload).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        signal: expect.any(AbortSignal),
      }));
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
  it("caches only thumbnail derivative metadata and issues a fresh link after each hit", async () => {
    const cache = new DerivativeCache({ maxBytes: 1024, ttlMs: 60_000 });
    const set = vi.spyOn(cache, "set");
    const deps = fakeMediaDeps({
      asset: fakeAsset({ type: "document", mime_type: "application/pdf", has_thumbnail: true }),
    });
    deps.derivativeCache = cache;
    deps.readThumbnail = vi.fn(async () => ({
      type: "image" as const,
      data: Buffer.from("thumb"),
      mimeType: "image/jpeg",
    }));
    deps.normalizeImage = vi.fn(async (data) => ({
      data,
      mimeType: "image/jpeg" as const,
      width: 320,
      height: 180,
    }));
    let linkNumber = 0;
    deps.attachOriginalLink = vi.fn(async (_asset, outcome) => {
      linkNumber += 1;
      const uri = `https://gramscope.test/api/media/fresh-${linkNumber}`;
      return {
        ...outcome,
        result: {
          ...outcome.result,
          download: { url: uri, expires_at: "2026-08-30T12:10:00.000Z" },
        },
        link: { uri, name: "report.pdf" },
      };
    });
    try {
      const first = await getMedia(input({ mode: "preview" }), deps);
      const warm = await getMedia(input({ mode: "preview" }), deps);

      expect(deps.readThumbnail).toHaveBeenCalledTimes(1);
      expect(deps.normalizeImage).toHaveBeenCalledTimes(1);
      expect(first.result.download?.url).not.toBe(warm.result.download?.url);
      expect(set).toHaveBeenCalledTimes(1);
      const cached = set.mock.calls[0]![1];
      expect(cached).toMatchObject({ mimeType: "image/jpeg", bytes: 5, width: 320, height: 180 });
      expect(JSON.stringify(cached)).not.toMatch(/url|token|expires_at/i);
    } finally {
      await cache.clear();
    }
  });

  it("never consults or writes the derivative cache for originals and source audio", async () => {
    const cache = {
      get: vi.fn(async () => undefined),
      set: vi.fn(async () => undefined),
    };
    const originalDeps = fakeMediaDeps();
    originalDeps.derivativeCache = cache;
    const audioDeps = fakeMediaDeps({
      asset: fakeAsset({ type: "voice", mime_type: "audio/ogg", size: 5 }),
    });
    audioDeps.derivativeCache = cache;

    await getMedia(input({ mode: "original" }), originalDeps);
    await getMedia(input(), audioDeps);

    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
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
