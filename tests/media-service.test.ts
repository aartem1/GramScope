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
} from "@/media/service";
import {
  iterAssetBytes,
  readAssetBytes,
  resolveMediaAsset,
} from "@/telegram/media";
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

afterEach(() => {
  telegramMocks.fetchDialogIndex.mockClear();
  telegramMocks.resolveSource.mockClear();
});

describe("Telegram media bytes", () => {
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
    const deps = fakeMediaDeps({ asset });

    const outcome = await getMedia(input(), deps);
    expect(JSON.stringify(outcome)).not.toContain("MESSAGE_REFERENCE_SENTINEL");
    expect(JSON.stringify(outcome)).not.toContain("MEDIA_ACCESS_HASH_SENTINEL");
  });
});
