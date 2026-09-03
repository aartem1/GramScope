import https from "node:https";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GramScopeError } from "@/errors/taxonomy";
import { createDispatcher } from "@/ops/dispatch";
import { RPC_REQUEST_BODY_MAX_BYTES } from "@/ops/wire";
import { createStaticHealthProvider, type HealthProvider } from "../worker/health";
import { listenWorkerServer } from "../worker/server";
import {
  createThrowawayTlsMaterial,
  removeThrowawayTlsMaterial,
  type ThrowawayTlsMaterial,
} from "./helpers/tls-fixtures";

type HttpResponse = {
  status: number;
  body: string;
};

function httpsRequest(
  tls: ThrowawayTlsMaterial,
  options: {
    port: number;
    path: string;
    method?: string;
    bearerToken?: string;
    body?: string;
    contentType?: string;
    useClientCert?: boolean;
  },
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {};
    if (options.bearerToken) {
      headers.authorization = `Bearer ${options.bearerToken}`;
    }
    if (options.body !== undefined) {
      headers["content-length"] = Buffer.byteLength(options.body);
      headers["content-type"] = options.contentType ?? "application/json";
    }

    const req = https.request(
      {
        host: "127.0.0.1",
        port: options.port,
        path: options.path,
        method: options.method ?? "GET",
        ca: tls.caPem,
        cert: options.useClientCert === false ? undefined : tls.clientCertPem,
        key: options.useClientCert === false ? undefined : tls.clientKeyPem,
        rejectUnauthorized: true,
        minVersion: "TLSv1.3",
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk as Buffer));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function startTestServer(
  tls: ThrowawayTlsMaterial,
  overrides: {
    healthProvider?: HealthProvider;
    dispatch?: ReturnType<typeof createDispatcher>;
    registeredOperations?: Set<string>;
  } = {},
) {
  const bearerToken = "integration-worker-token";
  const echoInput = z.object({ n: z.number() });
  const echoOutput = z.object({ n: z.number() });
  const dispatch =
    overrides.dispatch ??
    createDispatcher({
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
          throw new GramScopeError("RATE_LIMITED", "slow down", 9, true);
        },
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
    registeredOperations:
      overrides.registeredOperations ?? new Set(["echo", "fail"]),
    healthProvider:
      overrides.healthProvider ??
      createStaticHealthProvider({
        uptimeSeconds: 3,
        revision: "testrev",
        telegram: {
          connected: true,
          sessionFingerprint: "0123456789abcdef",
          authorizationCount: 1,
          lastErrorClass: null,
        },
      }),
  });

  return { handle, bearerToken };
}

describe("worker TLS integration", () => {
  it("rejects missing client certs, wrong bearer tokens, and round-trips valid calls", async () => {
    const tls = await createThrowawayTlsMaterial();
    const { handle, bearerToken } = await startTestServer(tls);

    try {
      await expect(
        httpsRequest(tls, {
          port: handle.port,
          path: "/health",
          useClientCert: false,
        }),
      ).rejects.toThrow();

      const wrongBearer = await httpsRequest(tls, {
        port: handle.port,
        path: "/health",
        bearerToken: "wrong-token",
      });
      expect(wrongBearer.status).toBe(401);

      const health = await httpsRequest(tls, {
        port: handle.port,
        path: "/health",
        bearerToken,
      });
      expect(health.status).toBe(200);
      expect(JSON.parse(health.body)).toMatchObject({
        revision: "testrev",
        telegram: { authorizationCount: 1 },
      });

      const rpc = await httpsRequest(tls, {
        port: handle.port,
        path: "/rpc",
        method: "POST",
        bearerToken,
        body: JSON.stringify({ op: "echo", input: { n: 4 } }),
      });
      expect(rpc.status).toBe(200);
      expect(JSON.parse(rpc.body)).toEqual({
        ok: true,
        result: { n: 5 },
      });

      const unknownOp = await httpsRequest(tls, {
        port: handle.port,
        path: "/rpc",
        method: "POST",
        bearerToken,
        body: JSON.stringify({ op: "missing", input: {} }),
      });
      expect(unknownOp.status).toBe(404);

      const domainFailure = await httpsRequest(tls, {
        port: handle.port,
        path: "/rpc",
        method: "POST",
        bearerToken,
        body: JSON.stringify({ op: "fail", input: {} }),
      });
      expect(domainFailure.status).toBe(200);
      expect(JSON.parse(domainFailure.body)).toEqual({
        ok: false,
        error: {
          code: "RATE_LIMITED",
          message: "slow down",
          retryable: true,
          retryAfterSeconds: 9,
        },
      });
    } finally {
      await handle.close();
      await removeThrowawayTlsMaterial(tls);
    }
  });

  it("requires application/json for /rpc", async () => {
    const tls = await createThrowawayTlsMaterial();
    const { handle, bearerToken } = await startTestServer(tls);

    try {
      const response = await httpsRequest(tls, {
        port: handle.port,
        path: "/rpc",
        method: "POST",
        bearerToken,
        contentType: "text/plain",
        body: JSON.stringify({ op: "echo", input: { n: 1 } }),
      });
      expect(response.status).toBe(415);
    } finally {
      await handle.close();
      await removeThrowawayTlsMaterial(tls);
    }
  });

  it("returns 413 for an oversized body without tearing down the connection early", async () => {
    const tls = await createThrowawayTlsMaterial();
    const { handle, bearerToken } = await startTestServer(tls);

    try {
      const oversized = "x".repeat(RPC_REQUEST_BODY_MAX_BYTES + 1);
      const response = await httpsRequest(tls, {
        port: handle.port,
        path: "/rpc",
        method: "POST",
        bearerToken,
        body: oversized,
      });
      expect(response.status).toBe(413);
      expect(JSON.parse(response.body)).toEqual({
        error: "Request body too large",
      });
    } finally {
      await handle.close();
      await removeThrowawayTlsMaterial(tls);
    }
  });

  it("returns 500 when the health provider emits malformed output", async () => {
    const tls = await createThrowawayTlsMaterial();
    const { handle, bearerToken } = await startTestServer(tls, {
      healthProvider: {
        getSnapshot() {
          return {
            revision: "testrev",
            telegram: {
              connected: true,
              sessionFingerprint: "0123456789abcdef",
              authorizationCount: 1,
              lastErrorClass: null,
            },
          } as never;
        },
      },
    });

    try {
      const response = await httpsRequest(tls, {
        port: handle.port,
        path: "/health",
        bearerToken,
      });
      expect(response.status).toBe(500);
      expect(response.body).not.toContain("uptimeSeconds");
    } finally {
      await handle.close();
      await removeThrowawayTlsMaterial(tls);
    }
  });
});
