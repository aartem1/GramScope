import { describe, expect, it, vi } from "vitest";
import { GramScopeError, mediaError } from "@/errors/taxonomy";
import {
  contentDispositionAttachment,
  handleOriginalRequest,
  type OriginalRouteDependencies,
} from "@/media/original-route";
import {
  parseSingleRange,
  RangeNotSatisfiableError,
} from "@/media/range";
import type { MediaTokenClaims } from "@/media/token";
import type { MediaAsset } from "@/telegram/media";
import type { TelegramLike } from "@/telegram/client";

const claims: MediaTokenClaims = {
  v: 1,
  purpose: "telegram-original",
  sourceId: "-1001",
  messageId: 7,
  ownerId: "owner-1",
};

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
  asset?: MediaAsset;
  iter?: (options: {
    offset?: number;
    limit?: number;
    signal?: AbortSignal;
  }) => AsyncIterable<Buffer>;
} = {}): OriginalRouteDependencies & {
  resolveAsset: ReturnType<typeof vi.fn>;
} {
  const client = {} as TelegramLike;
  return {
    verifyToken: vi.fn(async () => claims),
    withClient: async <T>(run: (value: TelegramLike) => Promise<T>) => run(client),
    resolveAsset: vi.fn(async () => options.asset ?? routeAsset(options.size ?? 10)),
    iterBytes: (_client, _asset, input) =>
      options.iter?.(input) ?? (async function* () {
        yield Buffer.from("0123456789");
      })(),
    ownerId: "owner-1",
  };
}

describe("single byte ranges", () => {
  it.each([
    [null, undefined],
    ["bytes=0-9", { start: 0, end: 9, length: 10 }],
    ["bytes=90-", { start: 90, end: 99, length: 10 }],
    ["bytes=-10", { start: 90, end: 99, length: 10 }],
  ] as const)("parses %s", (header, expected) => {
    expect(parseSingleRange(header, 100)).toEqual(expected);
  });

  it.each([
    "bytes=100-101",
    "bytes=20-10",
    "bytes=0-1,4-5",
    "items=0-1",
  ])("rejects invalid or multiple range %s", (header) => {
    expect(() => parseSingleRange(header, 100)).toThrow(RangeNotSatisfiableError);
  });
});

describe("original media route", () => {
  it("streams only the requested bytes without buffering the original", async () => {
    const chunksRequested: Array<{ offset?: number; limit?: number }> = [];
    const response = await handleOriginalRequest(
      new Request("https://gramscope.test/api/media/token", {
        headers: { range: "bytes=2-5" },
      }),
      "token",
      fakeOriginalDeps({
        iter: async function* (options) {
          chunksRequested.push({ offset: options.offset, limit: options.limit });
          yield Buffer.from("2345");
        },
      }),
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(response.headers.get("content-length")).toBe("4");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).toBe("2345");
    expect(chunksRequested).toEqual([{ offset: 2, limit: 4 }]);
  });

  it("returns a full attachment with exact safe headers", async () => {
    const response = await handleOriginalRequest(
      new Request("https://gramscope.test/api/media/token"),
      "token",
      fakeOriginalDeps(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-length")).toBe("10");
    expect(response.headers.get("content-disposition")).toBe(
      "attachment; filename=\"sample.bin\"; filename*=UTF-8''sample.bin",
    );
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("0123456789");
  });

  it("sanitizes Cyrillic, quotes, and CR/LF in attachment filenames", () => {
    const value = contentDispositionAttachment("при\"вет\r\n.txt");
    expect(value).toBe(
      "attachment; filename=\"_________.txt\"; filename*=UTF-8''%D0%BF%D1%80%D0%B8_%D0%B2%D0%B5%D1%82__.txt",
    );
    expect(value).not.toMatch(/[\r\n]/);
  });

  it("returns safe status codes for token, owner, media, and Range failures", async () => {
    const invalidToken = fakeOriginalDeps();
    invalidToken.verifyToken = vi.fn(async () => {
      throw new GramScopeError("AUTH_REQUIRED", "invalid");
    });
    expect((await handleOriginalRequest(
      new Request("https://x.test/api/media/x"),
      "x",
      invalidToken,
    )).status).toBe(401);
    expect(invalidToken.resolveAsset).not.toHaveBeenCalled();

    const wrongOwner = fakeOriginalDeps();
    wrongOwner.verifyToken = vi.fn(async () => ({ ...claims, ownerId: "owner-2" }));
    expect((await handleOriginalRequest(
      new Request("https://x.test/api/media/x"),
      "x",
      wrongOwner,
    )).status).toBe(401);
    expect(wrongOwner.resolveAsset).not.toHaveBeenCalled();

    const missing = fakeOriginalDeps();
    missing.resolveAsset = vi.fn(async () => {
      throw mediaError("MEDIA_NOT_FOUND", "missing", false);
    });
    expect((await handleOriginalRequest(
      new Request("https://x.test/api/media/x"),
      "x",
      missing,
    )).status).toBe(404);

    const rangeIterator = vi.fn(async function* () {
      yield Buffer.from("should-not-run");
    });
    const rangeDeps = fakeOriginalDeps({ iter: rangeIterator });
    const range = await handleOriginalRequest(
      new Request("https://x.test/api/media/x", {
        headers: { range: "bytes=99-100" },
      }),
      "x",
      rangeDeps,
    );
    expect(range.status).toBe(416);
    expect(range.headers.get("content-range")).toBe("bytes */10");
    expect(rangeIterator).not.toHaveBeenCalled();
  });

  it("returns 422 without starting a stream when authoritative size is absent", async () => {
    const deps = fakeOriginalDeps({ asset: routeAsset() });
    deps.resolveAsset.mockResolvedValue({
      ...routeAsset(),
      descriptor: { ...routeAsset().descriptor, size: undefined },
    });
    const response = await handleOriginalRequest(
      new Request("https://x.test/api/media/x"),
      "x",
      deps,
    );
    expect(response.status).toBe(422);
  });

  it("pulls one chunk at a time and propagates cancellation", async () => {
    let pulls = 0;
    let aborted = false;
    const deps = fakeOriginalDeps({
      size: 20 * 1024 * 1024,
      iter: async function* (options) {
        options.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        while (!options.signal?.aborted) {
          pulls++;
          yield Buffer.alloc(512 * 1024);
        }
      },
    });
    const response = await handleOriginalRequest(
      new Request("https://x.test/api/media/x"),
      "x",
      deps,
    );
    const reader = response.body!.getReader();
    await reader.read();
    expect(pulls).toBe(1);
    await reader.cancel();
    expect(aborted).toBe(true);
  });
});
