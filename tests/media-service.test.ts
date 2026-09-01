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
  getMedia,
  type MediaAsset,
  type MediaDependencies,
  type MediaOutcome,
} from "@/media/service";
import {
  downloadAssetToFile,
  iterAssetBytes,
  readAssetBytes,
  resolveMediaAsset,
} from "@/telegram/media";
import { mapMessage } from "@/schemas/message";
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

  it("rejects an overlong source id before media resolution", () => {
    expect(() => getMediaInputSchema.parse({
      source_id: "x".repeat(257),
      message_id: 7,
    })).toThrow();
  });

  it("builds link-only MCP content", () => {
    const result = mediaToolResult({
      result: {
        status: "ready",
        source_id: "-1001",
        message_id: 7,
        representation: {
          kind: "image",
          mime_type: "image/jpeg",
          delivery: "resource_link",
        },
      },
      link: {
        uri: "https://gramscope.test/api/media/view/capability",
        name: "photo-7.jpg",
        mimeType: "image/jpeg",
      },
    });
    expect(result.content.map((part) => part.type)).toEqual(["text", "resource_link"]);
    expect(JSON.stringify(result)).not.toMatch(/"data"\s*:/);
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

function oversizedMediaOutcome(): MediaOutcome {
  return {
    result: {
      status: "ready",
      source_id: "-1001",
      message_id: 7,
      media: {
        media_id: "med_test",
        type: "document",
        file_name: "🪁".repeat(20_000),
      },
      representation: { kind: "document", delivery: "resource_link" },
    },
    link: {
      uri: "https://gramscope.test/api/media/capability",
      name: "🪁".repeat(20_000),
    },
  };
}

type PlannerTestDependencies = MediaDependencies & {
  resolveAsset: ReturnType<typeof vi.fn>;
  readBytes: ReturnType<typeof vi.fn>;
  readThumbnail: ReturnType<typeof vi.fn>;
  downloadToFile: ReturnType<typeof vi.fn>;
};

function fakePlannerDeps(options: {
  asset?: MediaAsset;
} = {}): PlannerTestDependencies {
  const client = fakeMediaClient();
  return {
    withClient: async <T>(run: (value: TelegramLike) => Promise<T>) => run(client),
    resolveAsset: vi.fn(async () => options.asset ?? fakeAsset()),
    issueCapability: vi.fn(async () => ({
      token: "capability-token",
      expiresAt: new Date("2026-08-30T12:10:00.000Z"),
    })),
    mediaOrigin: "https://gramscope.test",
    ownerId: "owner-1",
    // Test-only sentinels: production dependencies deliberately omit byte readers.
    readBytes: vi.fn(),
    readThumbnail: vi.fn(async () => undefined),
    downloadToFile: vi.fn(),
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

  it("returns a bounded voice as one link with no audio block", async () => {
    const outcome = await getMedia(input(), fakePlannerDeps({
      asset: fakeAsset({ type: "voice", mime_type: "audio/ogg", size: 128 }),
    }));
    const tool = mediaToolResult(outcome);

    expect(tool.content.map((part) => part.type)).toEqual(["text", "resource_link"]);
    expect(tool.content.filter((part) => part.type === "audio")).toHaveLength(0);
    expect(outcome.result.download?.url).toBe((tool.content[1] as { uri: string }).uri);
  });

  it("does not advertise unknown generic image view metadata", async () => {
    const outcome = await getMedia(input(), fakePlannerDeps({
      asset: fakeAsset({
        type: "photo",
        mime_type: "image/webp",
        file_name: "source.webp",
        size: 12_345,
      }),
    }));

    expect(outcome.link).toMatchObject({ name: "preview-7" });
    expect(outcome.link).not.toHaveProperty("mimeType");
    expect(outcome.link).not.toHaveProperty("size");
    expect(outcome.result.representation).not.toHaveProperty("mime_type");
    expect(outcome.result.representation?.file_name).toBe("preview-7");
  });

  it("advertises only the guaranteed metadata for a video contact sheet", async () => {
    const outcome = await getMedia(input(), fakePlannerDeps({
      asset: fakeAsset({ type: "video", mime_type: "video/mp4", size: 12_345 }),
    }));

    expect(outcome.link).toMatchObject({
      mimeType: "image/jpeg",
      name: "contact-sheet-7.jpg",
    });
    expect(outcome.link).not.toHaveProperty("size");
    expect(outcome.result.representation).toMatchObject({
      mime_type: "image/jpeg",
      file_name: "contact-sheet-7.jpg",
    });
  });

  it("preserves known source metadata for an original voice link", async () => {
    const outcome = await getMedia(input(), fakePlannerDeps({
      asset: fakeAsset({
        type: "voice",
        mime_type: "audio/ogg",
        file_name: "voice-message.ogg",
        size: 12_345,
      }),
    }));

    expect(outcome.link).toMatchObject({
      mimeType: "audio/ogg",
      size: 12_345,
      name: "voice-message.ogg",
    });
  });

  it("compacts long multibyte Telegram metadata below the tool result limit", async () => {
    const outcome = await getMedia(input(), fakePlannerDeps({
      asset: fakeAsset({
        type: "voice",
        mime_type: "audio/ogg",
        file_name: "🪁".repeat(20_000),
      }),
    }));
    const tool = mediaToolResult(outcome);

    expect(Buffer.byteLength(JSON.stringify(tool), "utf8")).toBeLessThan(32 * 1024);
    expect(Buffer.byteLength(outcome.result.media?.file_name ?? "", "utf8")).toBeLessThanOrEqual(512);
    expect(outcome.result.media?.file_name).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("rejects a direct oversized media outcome at the result builder boundary", () => {
    expect(() => mediaToolResult(oversizedMediaOutcome()))
      .toThrowError(/32 KiB response limit/);
  });

  it("converts an oversized media outcome into a compact safe error", async () => {
    const result = await runGetMediaTool(input(), async () => oversizedMediaOutcome());

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(32 * 1024);
  });

  it("keeps repeated photo, video, and voice results below the aggregate limit", async () => {
    const tools = await Promise.all([
      getMedia(input(), fakePlannerDeps({ asset: fakeAsset({ type: "photo" }) })),
      getMedia(input(), fakePlannerDeps({ asset: fakeAsset({ type: "video", mime_type: "video/mp4" }) })),
      getMedia(input(), fakePlannerDeps({ asset: fakeAsset({ type: "voice", mime_type: "audio/ogg" }) })),
    ]);
    const serialized = tools.flatMap((outcome) => [
      JSON.stringify(mediaToolResult(outcome)),
      JSON.stringify(mediaToolResult(outcome)),
    ]);

    expect(serialized.join("").length).toBeLessThan(96 * 1024);
  });

  it("issues the planned capability and avoids Telegram transport serialization", async () => {
    const asset = fakeAsset({ type: "document", mime_type: "application/pdf", file_name: "report.pdf" });
    asset.rawMessage.fileReference = "MESSAGE_REFERENCE_SENTINEL";
    asset.rawMedia.accessHash = "MEDIA_ACCESS_HASH_SENTINEL";
    const deps = fakePlannerDeps({ asset });

    const outcome = await getMedia(input(), deps);

    expect(deps.issueCapability).toHaveBeenCalledWith(expect.objectContaining({
      v: 2,
      purpose: "telegram-media",
      ownerId: "owner-1",
      representation: { kind: "original" },
    }));
    expect(outcome.result).toMatchObject({
      status: "ready",
      representation: { kind: "document", delivery: "resource_link" },
    });
    expect(JSON.stringify(outcome)).not.toContain("MESSAGE_REFERENCE_SENTINEL");
    expect(JSON.stringify(outcome)).not.toContain("MEDIA_ACCESS_HASH_SENTINEL");
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
          media: { media_id: "med_test", type: "photo", size: 5 },
          representation: { kind: "image", byte_size: 5, delivery: "resource_link" },
        },
      }),
      (line) => lines.push(line),
    );

    expect(lines).toEqual([expect.stringContaining("media_kind=photo")]);
    expect(lines[0]).toContain("bytes=5");
    expect(lines[0]).not.toContain("-1001");
  });
});
