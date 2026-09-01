import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mediaError } from "@/errors/taxonomy";
import { DerivativeCache } from "@/media/cache";
import {
  materializeMediaView,
  AUTO_VIDEO_DEADLINE_MS,
  AUTO_VIDEO_MAX_BYTES,
  FRAMES_VIDEO_DEADLINE_MS,
  FRAMES_VIDEO_MAX_BYTES,
  type GeneratedMediaView,
  type MaterializerDependencies,
} from "@/media/materializer";
import type { MediaRepresentationPlan } from "@/media/representation";
import {
  handleViewRequest,
  type ViewRouteDependencies,
} from "@/media/view-route";
import sharp from "sharp";
import type { TelegramLike } from "@/telegram/client";
import type { MediaAsset } from "@/telegram/media";
import type { VerifiedMediaCapability } from "@/media/token";

afterEach(() => {
  vi.useRealTimers();
});

const baseClaims: Extract<VerifiedMediaCapability, { v: 2 }> = {
  v: 2,
  purpose: "telegram-media",
  sourceId: "-1001",
  messageId: 7,
  ownerId: "owner-1",
  representation: { kind: "image", source: "auto" },
};

function asset(overrides: Partial<MediaAsset["descriptor"]> = {}): MediaAsset {
  return {
    sourceId: "-1001",
    messageId: 7,
    sourceHandle: "@news",
    descriptor: {
      media_id: "med_view",
      type: "photo",
      mime_type: "image/jpeg",
      size: 100,
      ...overrides,
    },
    rawMessage: { id: 7 },
    rawMedia: { className: "MessageMediaPhoto" },
  };
}

function client(): TelegramLike {
  return {} as TelegramLike;
}

const generatedImage: GeneratedMediaView = {
  data: Buffer.from("jpeg"),
  mimeType: "image/jpeg",
  width: 1200,
  height: 800,
};

function fakeViewDeps(options: {
  claims?: VerifiedMediaCapability;
  asset?: MediaAsset;
  generated?: GeneratedMediaView;
  materializeError?: Error;
  resolveError?: Error;
} = {}): ViewRouteDependencies & {
  resolveAsset: ReturnType<typeof vi.fn>;
  materialize: ReturnType<typeof vi.fn>;
} {
  const telegram = client();
  return {
    verifyToken: vi.fn(async () => options.claims ?? baseClaims),
    withClient: async <T>(run: (value: TelegramLike) => Promise<T>) => run(telegram),
    resolveAsset: vi.fn(async () => {
      if (options.resolveError) throw options.resolveError;
      return options.asset ?? asset();
    }),
    materialize: vi.fn(async () => {
      if (options.materializeError) throw options.materializeError;
      return options.generated ?? generatedImage;
    }),
    ownerId: "owner-1",
  };
}

function fakeMaterializerDeps(options: {
  contactError?: Error;
  thumbnail?: { data: Buffer; mimeType: string };
} = {}): Partial<MaterializerDependencies> & {
  readBytes: ReturnType<typeof vi.fn>;
  readThumbnail: ReturnType<typeof vi.fn>;
  downloadToFile: ReturnType<typeof vi.fn>;
  contactSheet: ReturnType<typeof vi.fn>;
} {
  return {
    readBytes: vi.fn(async () => Buffer.from("source")),
    readThumbnail: vi.fn(async () => options.thumbnail),
    normalizeImage: vi.fn(async (data: Buffer) => ({
      data,
      mimeType: "image/jpeg" as const,
      width: 1200,
      height: 800,
    })),
    downloadToFile: vi.fn(async (_client, _asset, input) => {
      await writeFile(input.path, "video");
      return 5;
    }),
    probeDuration: vi.fn(async () => 90),
    contactSheet: vi.fn(async (_inputPath, request) => {
      if (options.contactError) throw options.contactError;
      return {
        data: Buffer.from("jpeg"),
        mimeType: "image/jpeg" as const,
        width: 1200,
        height: 800,
        frameCount: request.timestampsSeconds.length,
        timestampsSeconds: request.timestampsSeconds,
      };
    }),
    derivativeCache: undefined,
  };
}

describe("media view route", () => {
  it("materializes a normalized image only after the view link is opened", async () => {
    const deps = fakeViewDeps({
      claims: { ...baseClaims, representation: { kind: "image", source: "auto" } },
      generated: generatedImage,
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

  it("returns a generated contact sheet as a fixed-size attachment", async () => {
    const deps = fakeViewDeps({
      claims: {
        ...baseClaims,
        representation: { kind: "contact_sheet", mode: "auto", maxFrames: 8 },
      },
      generated: { ...generatedImage, frameCount: 8, timestampsSeconds: [10, 20] },
    });
    const response = await handleViewRequest(
      new Request("https://gramscope.test/api/media/view/token"), "token", deps,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("photo-7.jpg");
    expect(response.headers.get("accept-ranges")).toBeNull();
    expect(await response.text()).toBe("jpeg");
  });

  it.each([
    ["wrong owner", { ...baseClaims, ownerId: "other" } as VerifiedMediaCapability],
    ["legacy claim", {
      v: 1, purpose: "telegram-original", sourceId: "-1001", messageId: 7, ownerId: "owner-1",
    } as VerifiedMediaCapability],
    ["v2 original", {
      ...baseClaims, representation: { kind: "original" },
    } as VerifiedMediaCapability],
  ])("rejects %s before reading Telegram media", async (_name, claims) => {
    const deps = fakeViewDeps({ claims });
    const response = await handleViewRequest(new Request("https://x.test/view/token"), "token", deps);

    expect(response.status).toBe(401);
    expect(deps.resolveAsset).not.toHaveBeenCalled();
  });

  it.each([
    ["missing media", () => fakeViewDeps({ resolveError: mediaError("MEDIA_NOT_FOUND", "missing", false) }), 404],
    ["oversized image", () => fakeViewDeps({ materializeError: mediaError("INLINE_LIMIT_EXCEEDED", "large", false) }), 422],
    ["unsupported media", () => fakeViewDeps({ materializeError: mediaError("UNSUPPORTED_MEDIA", "none", false) }), 422],
    ["processing timeout", () => fakeViewDeps({ materializeError: mediaError("PROCESSING_TIMEOUT", "late", true) }), 504],
    ["Telegram failure", () => fakeViewDeps({ resolveError: mediaError("TELEGRAM_DOWNLOAD_FAILED", "telegram", true) }), 502],
  ])("maps %s to a safe HTTP status", async (_name, buildDeps, expected) => {
    const deps = buildDeps();
    const response = await handleViewRequest(new Request("https://x.test/view/token"), "token", deps);
    expect(response.status).toBe(expected);
    expect(await response.text()).not.toContain("telegram");
  });

  it("ignores a Range header because generated views are complete bounded files", async () => {
    const response = await handleViewRequest(
      new Request("https://x.test/view/token", { headers: { range: "bytes=1-2" } }),
      "token",
      fakeViewDeps(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-range")).toBeNull();
    expect(await response.text()).toBe("jpeg");
  });
});

describe("media view materialization", () => {
  const contactPlan: Extract<MediaRepresentationPlan, { kind: "contact_sheet" }> = {
    kind: "contact_sheet", mode: "auto", maxFrames: 8,
  };

  it("uses a normalized thumbnail when automatic contact-sheet processing fails", async () => {
    const deps = fakeMaterializerDeps({
      contactError: mediaError("PROCESSING_TIMEOUT", "late", true),
      thumbnail: { data: Buffer.from("thumb"), mimeType: "image/jpeg" },
    });

    await expect(materializeMediaView(client(), asset({ type: "video", mime_type: "video/mp4" }), contactPlan, deps))
      .resolves.toMatchObject({ data: Buffer.from("thumb"), width: 1200, height: 800 });
    expect(deps.readThumbnail).toHaveBeenCalledOnce();
  });

  it("normalizes a large automatic fallback thumbnail before returning it", async () => {
    const thumbnail = await sharp({
      create: { width: 2400, height: 1800, channels: 3, background: "#cc3311" },
    }).jpeg({ quality: 100 }).toBuffer();
    const deps = fakeMaterializerDeps({
      contactError: mediaError("PROCESSING_TIMEOUT", "late", true),
      thumbnail: { data: thumbnail, mimeType: "image/jpeg" },
    });
    deps.normalizeImage = (source, options) => import("@/media/image")
      .then(({ normalizeImage }) => normalizeImage(source, options));

    await expect(materializeMediaView(
      client(), asset({ type: "video", mime_type: "video/mp4" }), contactPlan, deps,
    )).resolves.toMatchObject({ mimeType: "image/jpeg", width: 1600, height: 1200 });
  });

  it("keeps automatic and explicit video budgets separate", async () => {
    const autoDeps = fakeMaterializerDeps();
    const video = asset({ type: "video", mime_type: "video/mp4", duration_seconds: 90 });
    await materializeMediaView(client(), video, contactPlan, autoDeps);
    expect(autoDeps.downloadToFile).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      path: expect.any(String),
      maxBytes: AUTO_VIDEO_MAX_BYTES,
      deadlineMs: AUTO_VIDEO_DEADLINE_MS,
      signal: expect.any(AbortSignal),
    });
    expect(autoDeps.contactSheet).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      timestampsSeconds: [10, 20, 30, 40, 50, 60, 70, 80],
    }));

    const framesDeps = fakeMaterializerDeps();
    const frames = await materializeMediaView(client(), video, {
      kind: "contact_sheet", mode: "frames", maxFrames: 3, timestampsSeconds: [8, 1, 5],
    }, framesDeps);
    expect(framesDeps.downloadToFile).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      path: expect.any(String),
      maxBytes: FRAMES_VIDEO_MAX_BYTES,
      deadlineMs: FRAMES_VIDEO_DEADLINE_MS,
      signal: expect.any(AbortSignal),
    });
    expect(framesDeps.contactSheet).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      timestampsSeconds: [1, 5, 8],
    }));
    expect(frames).toMatchObject({ frameCount: 3, timestampsSeconds: [1, 5, 8] });
  });

  it("probes a missing duration within the contact-sheet deadline", async () => {
    const deps = fakeMaterializerDeps();
    const video = asset({
      type: "video",
      mime_type: "video/mp4",
      duration_seconds: undefined,
    });

    await materializeMediaView(client(), video, contactPlan, deps);

    expect(deps.probeDuration).toHaveBeenCalledOnce();
    const probeSignal = vi.mocked(deps.probeDuration!).mock.calls[0]?.[1];
    const sheetSignal = deps.contactSheet.mock.calls[0]?.[1].deadline;
    expect(probeSignal).toBe(sheetSignal);
    expect(deps.contactSheet).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      timestampsSeconds: [10, 20, 30, 40, 50, 60, 70, 80],
    }));
  });

  it("rejects duplicate millisecond timestamps", async () => {
    await expect(materializeMediaView(
      client(),
      asset({ type: "video", mime_type: "video/mp4", duration_seconds: 90 }),
      {
        kind: "contact_sheet",
        mode: "frames",
        maxFrames: 2,
        timestampsSeconds: [1.0001, 1.0004],
      },
      fakeMaterializerDeps(),
    )).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("serializes different video views without delaying an image view", async () => {
    const deps = fakeMaterializerDeps();
    const releases: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    deps.contactSheet = vi.fn(async (_inputPath, request) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return {
        data: Buffer.from("jpeg"), mimeType: "image/jpeg" as const,
        width: 1200, height: 800, frameCount: request.timestampsSeconds.length,
        timestampsSeconds: request.timestampsSeconds,
      };
    });
    const first = materializeMediaView(
      client(), asset({ media_id: "med_video_1", type: "video", mime_type: "video/mp4" }), contactPlan, deps,
    );
    const second = materializeMediaView(
      client(), asset({ media_id: "med_video_2", type: "video", mime_type: "video/mp4" }), contactPlan, deps,
    );
    try {
      await vi.waitFor(() => expect(deps.contactSheet).toHaveBeenCalledTimes(1));
      await expect(materializeMediaView(
        client(), asset({ media_id: "med_image", type: "photo" }),
        { kind: "image", source: "auto" }, deps,
      )).resolves.toMatchObject({ data: Buffer.from("source") });
      expect(peak).toBe(1);

      releases.shift()!();
      await vi.waitFor(() => expect(deps.contactSheet).toHaveBeenCalledTimes(2));
      expect(peak).toBe(1);
      releases.shift()!();
      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    } finally {
      for (const release of releases) release();
      await Promise.allSettled([first, second]);
    }
  });

  it("expires an automatic waiter behind an explicit holder without poisoning FIFO", async () => {
    vi.useFakeTimers();
    const deps = fakeMaterializerDeps();
    const downloadSignals: AbortSignal[] = [];
    deps.downloadToFile = vi.fn(async (_client, _asset, options) => {
      downloadSignals.push(options.signal!);
      return 10_000;
    });
    let releaseFirst!: () => void;
    let markStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let processorCalls = 0;
    deps.contactSheet = vi.fn(async (_path, request) => {
      processorCalls += 1;
      if (processorCalls === 1) {
        markStarted();
        await firstGate;
      }
      return {
        data: Buffer.from("jpeg"),
        mimeType: "image/jpeg" as const,
        width: 1200,
        height: 800,
        frameCount: request.timestampsSeconds.length,
        timestampsSeconds: request.timestampsSeconds,
      };
    });
    const video = (mediaId: string) => asset({
      media_id: mediaId,
      type: "video",
      mime_type: "video/mp4",
      duration_seconds: 90,
    });
    const explicitPlan = {
      kind: "contact_sheet",
      mode: "frames",
      maxFrames: 8,
    } as const;

    let holderSettled = false;
    const holder = materializeMediaView(client(), video("holder"), explicitPlan, deps);
    void holder.finally(() => { holderSettled = true; });
    await firstStarted;
    const expiring = materializeMediaView(client(), video("expiring"), contactPlan, deps);
    const expiringOutcome = expiring.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    const liveAfterCancelled = materializeMediaView(
      client(), video("live"), explicitPlan, deps,
    );
    await vi.advanceTimersByTimeAsync(AUTO_VIDEO_DEADLINE_MS + 1);
    try {
      await expect(expiringOutcome).resolves.toMatchObject({
        error: { code: "PROCESSING_TIMEOUT", retryable: true },
      });
      expect(holderSettled).toBe(false);
      expect(downloadSignals).toHaveLength(1);
      expect(deps.contactSheet).toHaveBeenCalledTimes(1);

      releaseFirst();
      await expect(holder).resolves.toMatchObject({ mimeType: "image/jpeg" });
      await expect(liveAfterCancelled).resolves.toMatchObject({ mimeType: "image/jpeg" });
      expect(downloadSignals).toHaveLength(2);
      expect(deps.contactSheet).toHaveBeenCalledTimes(2);
    } finally {
      releaseFirst();
      await Promise.allSettled([holder, expiring, liveAfterCancelled]);
    }
  });

  it("single-flights a contact sheet and serves the warm result from its cache", async () => {
    const cache = new DerivativeCache({ maxBytes: 1024, ttlMs: 60_000 });
    const deps = fakeMaterializerDeps();
    deps.derivativeCache = cache;
    try {
      const viewAsset = asset({ type: "video", mime_type: "video/mp4", duration_seconds: 90 });
      const [first, concurrent] = await Promise.all([
        materializeMediaView(client(), viewAsset, contactPlan, deps),
        materializeMediaView(client(), viewAsset, contactPlan, deps),
      ]);
      const warm = await materializeMediaView(client(), viewAsset, contactPlan, deps);

      expect(first.data.equals(Buffer.from("jpeg"))).toBe(true);
      expect(concurrent).toMatchObject({ width: 1200, height: 800 });
      expect(warm).toMatchObject({ width: 1200, height: 800 });
      expect(deps.downloadToFile).toHaveBeenCalledTimes(1);
      expect(deps.contactSheet).toHaveBeenCalledTimes(1);
    } finally {
      await cache.clear();
    }
  });

  it("removes the downloaded temporary video when contact-sheet processing fails", async () => {
    const deps = fakeMaterializerDeps({ contactError: new Error("processor failed") });
    let inputPath = "";
    deps.downloadToFile = vi.fn(async (_client, _asset, input) => {
      inputPath = input.path;
      await writeFile(input.path, "video");
      return 5;
    });

    await expect(materializeMediaView(
      client(), asset({ type: "video", mime_type: "video/mp4" }), contactPlan, deps,
    )).rejects.toThrow("processor failed");
    expect(inputPath).not.toBe("");
    await expect(access(inputPath)).rejects.toThrow();
  });

  it("removes an exact derivative file when cache ownership transfer fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gramscope-view-cache-test-"));
    const derivativePath = join(directory, "derivative.jpg");
    const deps = fakeMaterializerDeps();
    deps.derivativeCache = {
      get: vi.fn(async () => undefined),
      set: vi.fn(async () => { throw new Error("cache failed"); }),
    };
    deps.derivativePath = () => derivativePath;
    try {
      await expect(materializeMediaView(
        client(), asset({ type: "video", mime_type: "video/mp4" }),
        { kind: "contact_sheet", mode: "frames", maxFrames: 8 }, deps,
      )).rejects.toThrow("cache failed");
      await expect(access(derivativePath)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("removes an exact derivative file when its writer fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gramscope-view-writer-test-"));
    const derivativePath = join(directory, "derivative.jpg");
    const deps = fakeMaterializerDeps();
    const cache = new DerivativeCache({ maxBytes: 1024, ttlMs: 60_000 });
    deps.derivativeCache = cache;
    deps.derivativePath = () => derivativePath;
    deps.writeDerivative = async (path, data) => {
      await writeFile(path, data);
      throw new Error("writer failed");
    };
    try {
      await expect(materializeMediaView(
        client(), asset({ type: "video", mime_type: "video/mp4" }),
        { kind: "contact_sheet", mode: "frames", maxFrames: 8 }, deps,
      )).rejects.toThrow("writer failed");
      await expect(access(derivativePath)).rejects.toThrow();
    } finally {
      await cache.clear();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not use an automatic thumbnail fallback for explicit frames", async () => {
    const deps = fakeMaterializerDeps({
      contactError: mediaError("PROCESSING_TIMEOUT", "late", true),
      thumbnail: { data: Buffer.from("thumb"), mimeType: "image/jpeg" },
    });

    await expect(materializeMediaView(
      client(), asset({ type: "video", mime_type: "video/mp4" }),
      { kind: "contact_sheet", mode: "frames", maxFrames: 8 }, deps,
    )).rejects.toMatchObject({ code: "PROCESSING_TIMEOUT" });
    expect(deps.readThumbnail).not.toHaveBeenCalled();
  });

  it("never reads an oversized cached derivative into memory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gramscope-view-cache-read-test-"));
    const derivativePath = join(directory, "oversized.jpg");
    await writeFile(derivativePath, Buffer.alloc(2 * 1024 * 1024 + 1));
    const deps = fakeMaterializerDeps();
    deps.derivativeCache = {
      get: vi.fn(async () => ({
        path: derivativePath,
        bytes: 2 * 1024 * 1024 + 1,
        mimeType: "image/jpeg",
        width: 320,
        height: 180,
      })),
      set: vi.fn(async () => undefined),
    };
    try {
      await expect(materializeMediaView(
        client(), asset({ type: "video", mime_type: "video/mp4" }),
        { kind: "contact_sheet", mode: "frames", maxFrames: 8 }, deps,
      )).rejects.toMatchObject({ code: "INLINE_LIMIT_EXCEEDED" });
      expect(deps.downloadToFile).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a declared oversized video before creating a temporary file", async () => {
    const deps = fakeMaterializerDeps();
    await expect(materializeMediaView(
      client(),
      asset({ type: "video", mime_type: "video/mp4", size: 64 * 1024 * 1024 + 1 }),
      contactPlan,
      deps,
    )).rejects.toMatchObject({ code: "INLINE_LIMIT_EXCEEDED" });
    expect(deps.downloadToFile).not.toHaveBeenCalled();
  });
});
