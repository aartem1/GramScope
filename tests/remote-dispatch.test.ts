import { fetch as undiciFetch, type RequestInit } from "undici";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { WorkerClientConfig } from "@/config";
import { GramScopeError } from "@/errors/taxonomy";
import { createDispatcher } from "@/ops/dispatch";
import { createRemoteDispatcher } from "@/ops/remote";
import { rpcErrorResponse } from "@/ops/wire";
import { createStaticHealthProvider } from "../worker/health";
import { listenWorkerServer } from "../worker/server";
import {
  createThrowawayTlsMaterial,
  removeThrowawayTlsMaterial,
  type ThrowawayTlsMaterial,
} from "./helpers/tls-fixtures";

const echoInput = z.object({ n: z.number() });
const echoOutput = z.object({ n: z.number() });

function workerClientConfig(
  tls: ThrowawayTlsMaterial,
  port: number,
  bearerToken: string,
): WorkerClientConfig {
  return {
    workerUrl: `https://127.0.0.1:${port}`,
    workerToken: bearerToken,
    caPem: tls.caPem,
    clientCertPem: tls.clientCertPem,
    clientKeyPem: tls.clientKeyPem,
  };
}

async function startEchoWorker(tls: ThrowawayTlsMaterial) {
  const bearerToken = "remote-dispatch-token";
  const dispatch = createDispatcher({
    echo: {
      name: "echo",
      input: echoInput,
      output: echoOutput,
      handler: async (input: { n: number }) => ({ n: input.n + 1 }),
    },
    fail: {
      name: "fail",
      input: z.object({}),
      output: z.object({}),
      handler: async () => {
        throw new GramScopeError("CHANNEL_NOT_FOUND", "missing channel");
      },
    },
    mark_read: {
      name: "mark_read",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      handler: async () => ({ ok: true }),
    },
  });

  const handle = await listenWorkerServer({
    host: "127.0.0.1",
    port: 0,
    bearerToken,
    tls: {
      caPem: tls.caPem,
      serverCertPem: tls.serverCertPem,
      serverKeyPem: tls.serverKeyPem,
    },
    dispatch,
    registeredOperations: new Set(["echo", "fail", "mark_read"]),
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
  });

  return {
    handle,
    bearerToken,
    config: workerClientConfig(tls, handle.port, bearerToken),
  };
}

describe("remote dispatch", () => {
  it("round-trips a successful operation over mTLS", async () => {
    const tls = await createThrowawayTlsMaterial();
    const { handle, config } = await startEchoWorker(tls);

    try {
      const dispatch = createRemoteDispatcher({
        operations: {
          echo: {
            name: "echo",
            input: echoInput,
            output: echoOutput,
            handler: async () => ({ n: 0 }),
          },
        },
        config,
      });

      await expect(dispatch("echo", { n: 4 })).resolves.toEqual({ n: 5 });
    } finally {
      await handle.close();
      await removeThrowawayTlsMaterial(tls);
    }
  });

  it("maps ok:false wire errors through gramScopeErrorFromWire", async () => {
    const tls = await createThrowawayTlsMaterial();
    const { handle, config } = await startEchoWorker(tls);

    try {
      const dispatch = createRemoteDispatcher({
        operations: {
          fail: {
            name: "fail",
            input: z.object({}),
            output: z.object({}),
            handler: async () => ({}),
          },
        },
        config,
      });

      await expect(dispatch("fail", {})).rejects.toMatchObject({
        name: "GramScopeError",
        code: "CHANNEL_NOT_FOUND",
        message: "missing channel",
      });
    } finally {
      await handle.close();
      await removeThrowawayTlsMaterial(tls);
    }
  });

  it("downgrades unknown wire codes to INTERNAL_ERROR", async () => {
    const tls = await createThrowawayTlsMaterial();
    const { handle, config } = await startEchoWorker(tls);

    try {
      const dispatch = createRemoteDispatcher({
        operations: {
          echo: {
            name: "echo",
            input: echoInput,
            output: echoOutput,
            handler: async () => ({ n: 0 }),
          },
        },
        config,
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({
              ok: false,
              error: {
                code: "NOT_A_REAL_CODE",
                message: "from worker",
                retryable: false,
              },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          )) as never,
      });

      await expect(dispatch("echo", { n: 1 })).rejects.toMatchObject({
        code: "INTERNAL_ERROR",
        message: "from worker",
      });
    } finally {
      await handle.close();
      await removeThrowawayTlsMaterial(tls);
    }
  });

  it("maps transport failures to UPSTREAM_UNAVAILABLE", async () => {
    const tls = await createThrowawayTlsMaterial();
    const config = workerClientConfig(tls, 1, "token");

    const dispatch = createRemoteDispatcher({
      operations: {
        echo: {
          name: "echo",
          input: echoInput,
          output: echoOutput,
          handler: async () => ({ n: 0 }),
        },
      },
      config,
    });

    await expect(dispatch("echo", { n: 1 })).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
      retryable: true,
    });

    await removeThrowawayTlsMaterial(tls);
  });

  it("maps HTTP non-2xx to UPSTREAM_UNAVAILABLE without retrying", async () => {
    const tls = await createThrowawayTlsMaterial();
    const { handle, config } = await startEchoWorker(tls);
    let calls = 0;

    try {
      const dispatch = createRemoteDispatcher({
        operations: {
          echo: {
            name: "echo",
            input: echoInput,
            output: echoOutput,
            handler: async () => ({ n: 0 }),
          },
        },
        config,
        fetchImpl: (async () => {
          calls += 1;
          return new Response(JSON.stringify({ error: "overloaded" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }) as never,
      });

      await expect(dispatch("echo", { n: 1 })).rejects.toMatchObject({
        code: "UPSTREAM_UNAVAILABLE",
      });
      expect(calls).toBe(1);
    } finally {
      await handle.close();
      await removeThrowawayTlsMaterial(tls);
    }
  });

  it("retries read-only operations once when no response byte was received", async () => {
    const tls = await createThrowawayTlsMaterial();
    const { handle, config } = await startEchoWorker(tls);
    let calls = 0;

    try {
      const dispatch = createRemoteDispatcher({
        operations: {
          echo: {
            name: "echo",
            input: echoInput,
            output: echoOutput,
            handler: async () => ({ n: 0 }),
          },
        },
        config,
        fetchImpl: (async (url: string, init?: RequestInit) => {
          calls += 1;
          if (calls === 1) {
            throw new Error("connect ECONNREFUSED");
          }
          return undiciFetch(url, init);
        }) as never,
      });

      await expect(dispatch("echo", { n: 2 })).resolves.toEqual({ n: 3 });
      expect(calls).toBe(2);
    } finally {
      await handle.close();
      await removeThrowawayTlsMaterial(tls);
    }
  });

  it("never auto-retries writer operations on connection failure", async () => {
    const tls = await createThrowawayTlsMaterial();
    const { handle, config } = await startEchoWorker(tls);
    let calls = 0;

    try {
      const dispatch = createRemoteDispatcher({
        operations: {
          mark_read: {
            name: "mark_read",
            input: z.object({}),
            output: z.object({ ok: z.boolean() }),
            handler: async () => ({ ok: true }),
          },
        },
        config,
        fetchImpl: (async () => {
          calls += 1;
          throw new Error("connect ECONNREFUSED");
        }) as never,
      });

      await expect(dispatch("mark_read", {})).rejects.toMatchObject({
        code: "UPSTREAM_UNAVAILABLE",
      });
      expect(calls).toBe(1);
    } finally {
      await handle.close();
      await removeThrowawayTlsMaterial(tls);
    }
  });

  it("keeps in-process dispatch as the default when TELEGRAM_WORKER_URL is unset", async () => {
    const { isRemoteDispatchEnabled } = await import("@/config");
    expect(isRemoteDispatchEnabled({})).toBe(false);

    const dispatch = createDispatcher({
      echo: {
        name: "echo",
        input: echoInput,
        output: echoOutput,
        handler: async (input: { n: number }) => ({ n: input.n * 2 }),
      },
    });

    await expect(dispatch("echo", { n: 3 })).resolves.toEqual({ n: 6 });
  });
});

describe("remote dispatch rpcErrorResponse helper usage", () => {
  it("serializes synthetic unknown-code failures for worker stubs", () => {
    const payload = rpcErrorResponse(
      new GramScopeError("INTERNAL_ERROR", "from worker"),
    );
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe("INTERNAL_ERROR");
  });
});
