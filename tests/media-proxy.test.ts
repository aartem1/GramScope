import https from "node:https";
import { describe, expect, it, vi } from "vitest";
import { GramScopeError } from "@/errors/taxonomy";
import {
  contentDispositionAttachment,
  handleOriginalRequest,
  type OriginalRouteDependencies,
} from "@/media/original-route";
import type { MediaCapabilityClaims } from "@/media/token";
import {
  handleViewRequest,
  type ViewRouteDependencies,
} from "@/media/view-route";
import { MEDIA_REQUEST_BODY_MAX_BYTES } from "@/media/wire";
import type { TelegramLike } from "@/telegram/client";
import { deliverMedia } from "../worker/media-delivery";
import { createStaticHealthProvider } from "../worker/health";
import { listenWorkerServer } from "../worker/server";
import {
  createThrowawayTlsMaterial,
  removeThrowawayTlsMaterial,
  type ThrowawayTlsMaterial,
} from "./helpers/tls-fixtures";

const originalClaims: MediaCapabilityClaims = {
  v: 2,
  purpose: "telegram-media",
  sourceId: "-1001",
  messageId: 7,
  ownerId: "owner-1",
  representation: { kind: "original", byteSize: 10 },
};

const imageClaims: MediaCapabilityClaims = {
  v: 2,
  purpose: "telegram-media",
  sourceId: "-1001",
  messageId: 7,
  ownerId: "owner-1",
  representation: { kind: "image", source: "auto" },
};

function unusedLocalDeps(): Pick<
  OriginalRouteDependencies,
  "withClient" | "resolveAsset" | "iterBytes"
> {
  const client = {} as TelegramLike;
  return {
    withClient: async <T>(run: (value: TelegramLike) => Promise<T>) => run(client),
    resolveAsset: vi.fn(),
    iterBytes: vi.fn(),
  };
}

function proxyOriginalDeps(options: {
  claims?: MediaCapabilityClaims;
  fetchFromWorker?: OriginalRouteDependencies["fetchFromWorker"];
} = {}): OriginalRouteDependencies & {
  fetchFromWorker: ReturnType<typeof vi.fn>;
} {
  const fetchFromWorker = vi.fn(options.fetchFromWorker ?? (async () =>
    new Response("0123456789", {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": "10",
      },
    })));
  return {
    verifyToken: vi.fn(async () => options.claims ?? originalClaims),
    ownerId: "owner-1",
    fetchFromWorker,
    ...unusedLocalDeps(),
  };
}

function proxyViewDeps(options: {
  claims?: MediaCapabilityClaims;
  fetchFromWorker?: ViewRouteDependencies["fetchFromWorker"];
} = {}): ViewRouteDependencies & {
  fetchFromWorker: ReturnType<typeof vi.fn>;
} {
  const client = {} as TelegramLike;
  const fetchFromWorker = vi.fn(options.fetchFromWorker ?? (async () =>
    new Response("jpeg-bytes", {
      status: 200,
      headers: {
        "content-type": "image/jpeg",
        "content-length": "10",
      },
    })));
  return {
    verifyToken: vi.fn(async () => options.claims ?? imageClaims),
    ownerId: "owner-1",
    fetchFromWorker,
    withClient: async <T>(run: (value: TelegramLike) => Promise<T>) => run(client),
    resolveAsset: vi.fn(),
    materialize: vi.fn(),
  };
}

function httpsMediaRequest(
  tls: ThrowawayTlsMaterial,
  options: {
    port: number;
    body: unknown;
    bearerToken: string;
  },
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(options.body);
    const req = https.request(
      {
        host: "127.0.0.1",
        port: options.port,
        path: "/media",
        method: "POST",
        ca: tls.caPem,
        cert: tls.clientCertPem,
        key: tls.clientKeyPem,
        rejectUnauthorized: true,
        minVersion: "TLSv1.3",
        headers: {
          authorization: `Bearer ${options.bearerToken}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk as Buffer));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

describe("media proxy routes", () => {
  it("proxies a full original download with Vercel-owned headers", async () => {
    const deps = proxyOriginalDeps();
    const response = await handleOriginalRequest(
      new Request("https://gramscope.test/api/media/token"),
      "token",
      deps,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-length")).toBe("10");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-disposition")).toContain("download-7.bin");
    expect(await response.text()).toBe("0123456789");
    expect(deps.fetchFromWorker).toHaveBeenCalledWith(
      {
        sourceId: "-1001",
        messageId: 7,
        representation: { kind: "original" },
      },
      expect.any(AbortSignal),
    );
    expect(deps.resolveAsset).not.toHaveBeenCalled();
  });

  it("forwards a parsed byte range to the worker and copies 206 headers", async () => {
    const deps = proxyOriginalDeps({
      fetchFromWorker: async () =>
        new Response("2345", {
          status: 206,
          headers: {
            "content-type": "application/octet-stream",
            "content-length": "4",
            "content-range": "bytes 2-5/10",
          },
        }),
    });
    const response = await handleOriginalRequest(
      new Request("https://gramscope.test/api/media/token", {
        headers: { range: "bytes=2-5" },
      }),
      "token",
      deps,
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await response.text()).toBe("2345");
    expect(deps.fetchFromWorker).toHaveBeenCalledWith(
      {
        sourceId: "-1001",
        messageId: 7,
        representation: { kind: "original" },
        range: { start: 2, end: 5 },
      },
      expect.any(AbortSignal),
    );
  });

  it("rejects an unsatisfiable range locally without calling the worker", async () => {
    const deps = proxyOriginalDeps();
    const response = await handleOriginalRequest(
      new Request("https://gramscope.test/api/media/token", {
        headers: { range: "bytes=99-100" },
      }),
      "token",
      deps,
    );

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */10");
    expect(deps.fetchFromWorker).not.toHaveBeenCalled();
  });

  it("returns 422 for a range request when byteSize is absent from the token", async () => {
    const deps = proxyOriginalDeps({
      claims: {
        ...originalClaims,
        representation: { kind: "original" },
      },
    });
    const response = await handleOriginalRequest(
      new Request("https://gramscope.test/api/media/token", {
        headers: { range: "bytes=0-1" },
      }),
      "token",
      deps,
    );

    expect(response.status).toBe(422);
    expect(deps.fetchFromWorker).not.toHaveBeenCalled();
  });

  it("propagates client abort to the worker fetch", async () => {
    let workerSignal: AbortSignal | undefined;
    let releaseFetch!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const deps = proxyOriginalDeps({
      fetchFromWorker: async (_body, signal) => {
        workerSignal = signal;
        releaseFetch();
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      },
    });
    const controller = new AbortController();
    const responsePromise = handleOriginalRequest(
      new Request("https://gramscope.test/api/media/token", {
        signal: controller.signal,
      }),
      "token",
      deps,
    );
    await fetchStarted;
    controller.abort();
    await expect(responsePromise).rejects.toThrow();
    expect(workerSignal?.aborted).toBe(true);
  });

  it("proxies a view download with sanitized attachment headers", async () => {
    const deps = proxyViewDeps();
    const response = await handleViewRequest(
      new Request("https://gramscope.test/api/media/view/token"),
      "token",
      deps,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("accept-ranges")).toBeNull();
    expect(response.headers.get("content-disposition")).toContain("photo-7.jpg");
    expect(await response.text()).toBe("jpeg-bytes");
    expect(deps.fetchFromWorker).toHaveBeenCalledWith(
      {
        sourceId: "-1001",
        messageId: 7,
        representation: { kind: "image", source: "auto" },
      },
      expect.any(AbortSignal),
    );
    expect(deps.resolveAsset).not.toHaveBeenCalled();
  });

  it("passes through worker error statuses on the view route", async () => {
    const deps = proxyViewDeps({
      fetchFromWorker: async () => new Response("Not Found", { status: 404 }),
    });
    const response = await handleViewRequest(
      new Request("https://gramscope.test/api/media/view/token"),
      "token",
      deps,
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
  });
});

describe("worker POST /media", () => {
  it("streams an original byte range over mTLS", async () => {
    const tls = await createThrowawayTlsMaterial();
    const bearerToken = "media-worker-token";
    const handle = await listenWorkerServer({
      host: "127.0.0.1",
      port: 0,
      bearerToken,
      tls: {
        caPem: tls.caPem,
        serverCertPem: tls.serverCertPem,
        serverKeyPem: tls.serverKeyPem,
      },
      dispatch: async () => ({}),
      registeredOperations: new Set(),
      healthProvider: createStaticHealthProvider({
        uptimeSeconds: 1,
        revision: "test",
        telegram: {
          connected: true,
          sessionFingerprint: "0123456789abcdef",
          authorizationCount: 1,
          lastErrorClass: null,
        },
      }),
      deliverMedia: async (input) => ({
        kind: "stream",
        status: input.range ? 206 : 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": input.range
            ? String(input.range.end - input.range.start + 1)
            : "4",
          ...(input.range
            ? { "content-range": `bytes ${input.range.start}-${input.range.end}/10` }
            : {}),
          "accept-ranges": "bytes",
        },
        chunks: (async function* () {
          yield Buffer.from(input.range ? "2345" : "full");
        })(),
      }),
    });

    try {
      const ranged = await httpsMediaRequest(tls, {
        port: handle.port,
        bearerToken,
        body: {
          sourceId: "-1001",
          messageId: 7,
          representation: { kind: "original" },
          range: { start: 2, end: 5 },
        },
      });
      expect(ranged.status).toBe(206);
      expect(ranged.headers["content-range"]).toBe("bytes 2-5/10");
      expect(ranged.body.toString()).toBe("2345");

      const full = await httpsMediaRequest(tls, {
        port: handle.port,
        bearerToken,
        body: {
          sourceId: "-1001",
          messageId: 7,
          representation: { kind: "original" },
        },
      });
      expect(full.status).toBe(200);
      expect(full.body.toString()).toBe("full");
    } finally {
      await handle.close();
      await removeThrowawayTlsMaterial(tls);
    }
  });

  it("rejects oversize media request bodies", async () => {
    const tls = await createThrowawayTlsMaterial();
    const bearerToken = "media-worker-token";
    const handle = await listenWorkerServer({
      host: "127.0.0.1",
      port: 0,
      bearerToken,
      tls: {
        caPem: tls.caPem,
        serverCertPem: tls.serverCertPem,
        serverKeyPem: tls.serverKeyPem,
      },
      dispatch: async () => ({}),
      registeredOperations: new Set(),
      healthProvider: createStaticHealthProvider({
        uptimeSeconds: 1,
        revision: "test",
        telegram: {
          connected: true,
          sessionFingerprint: "0123456789abcdef",
          authorizationCount: 1,
          lastErrorClass: null,
        },
      }),
      deliverMedia: async () => ({
        kind: "buffer",
        status: 200,
        headers: { "content-type": "image/jpeg", "content-length": "1" },
        data: Buffer.from("x"),
      }),
    });

    try {
      const huge = "a".repeat(MEDIA_REQUEST_BODY_MAX_BYTES + 1);
      const response = await httpsMediaRequest(tls, {
        port: handle.port,
        bearerToken,
        body: { sourceId: huge, messageId: 1, representation: { kind: "original" } },
      });
      expect(response.status).toBe(413);
    } finally {
      await handle.close();
      await removeThrowawayTlsMaterial(tls);
    }
  });

  it("maps delivery failures to safe HTTP statuses", async () => {
    const outcome = await deliverMedia(
      {
        sourceId: "-1001",
        messageId: 7,
        representation: { kind: "original" },
      },
      undefined,
      {
        withClient: async (run) => run({} as TelegramLike),
        resolveAsset: async () => {
          throw new GramScopeError("MEDIA_NOT_FOUND", "missing");
        },
        iterBytes: vi.fn(),
        materialize: vi.fn(),
      },
    );
    expect(outcome).toMatchObject({ kind: "error", status: 404 });
  });
});

describe("contentDispositionAttachment", () => {
  it("remains stable for proxy-generated filenames", () => {
    expect(contentDispositionAttachment("sample.bin")).toContain('filename="sample.bin"');
  });
});
