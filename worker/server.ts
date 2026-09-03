import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { GramScopeError } from "../src/errors/taxonomy";
import { mapTelegramError } from "../src/errors/from-telegram";
import {
  DEFAULT_RPC_DEADLINE_MS,
  RPC_REQUEST_BODY_MAX_BYTES,
  rpcErrorResponse,
  rpcRequestSchema,
  rpcSuccessResponse,
} from "../src/ops/wire";
import { verifyBearerToken } from "./auth";
import {
  DEFAULT_MAX_CONCURRENT_OPERATIONS,
  DEFAULT_OPERATION_QUEUE_WAIT_MS,
  OperationGate,
  OperationQueueTimeoutError,
} from "./concurrency";
import { healthPayloadSchema, type HealthProvider } from "./health";
import { executeRpcOperation } from "./rpc-execution";
import {
  deliverMedia,
  type MediaDeliveryResult,
} from "./media-delivery";
import {
  MEDIA_REQUEST_BODY_MAX_BYTES,
  mediaRequestSchema,
} from "../src/media/wire";
import { z } from "zod";

export type WorkerTlsMaterial = {
  caPem: string;
  serverCertPem: string;
  serverKeyPem: string;
};

export type WorkerServerOptions = {
  host: string;
  port: number;
  bearerToken: string;
  tls: WorkerTlsMaterial;
  dispatch: (op: string, input: unknown) => Promise<unknown>;
  registeredOperations: ReadonlySet<string>;
  healthProvider: HealthProvider;
  rpcDeadlineMs?: number;
  gate?: OperationGate;
  deliverMedia?: (
    input: import("../src/media/wire").MediaRequestBody,
    signal?: AbortSignal,
  ) => Promise<MediaDeliveryResult>;
};

export type WorkerServerHandle = {
  server: Server;
  port: number;
  close(): Promise<void>;
};

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;

    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      total += chunk.length;
      if (total > maxBytes) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (tooLarge) {
        reject(new BodyTooLargeError());
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", reject);
  });
}

export class BodyTooLargeError extends Error {
  constructor() {
    super("Request body too large");
    this.name = "BodyTooLargeError";
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function mapExecutionError(err: unknown): GramScopeError {
  if (err instanceof GramScopeError) return err;
  if (err instanceof z.ZodError) {
    return new GramScopeError("INVALID_INPUT", "Invalid operation input.");
  }
  return mapTelegramError(err);
}

function authorizeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  bearerToken: string,
): boolean {
  if (!verifyBearerToken(req.headers.authorization, bearerToken)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return false;
  }
  return true;
}

function hasJsonContentType(req: IncomingMessage): boolean {
  const raw = req.headers["content-type"];
  if (raw === undefined) return false;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value.toLowerCase().startsWith("application/json");
}

function sendText(
  res: ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(message),
    ...headers,
  });
  res.end(message);
}

async function writeMediaDelivery(
  res: ServerResponse,
  outcome: MediaDeliveryResult,
  signal?: AbortSignal,
): Promise<void> {
  if (outcome.kind === "error") {
    sendText(res, outcome.status, outcome.message, outcome.headers ?? {});
    return;
  }

  if (outcome.kind === "buffer") {
    res.writeHead(outcome.status, outcome.headers);
    res.end(outcome.data);
    return;
  }

  res.writeHead(outcome.status, outcome.headers);
  try {
    for await (const chunk of outcome.chunks) {
      if (signal?.aborted) break;
      const canContinue = res.write(chunk);
      if (!canContinue) {
        await new Promise<void>((resolve) => res.once("drain", resolve));
      }
    }
  } catch {
    if (!res.headersSent) {
      sendText(res, 502, "Media delivery failed");
      return;
    }
  }
  res.end();
}

async function handleMediaRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deliver: NonNullable<WorkerServerOptions["deliverMedia"]>,
): Promise<void> {
  if (!hasJsonContentType(req)) {
    sendText(res, 415, "Content-Type must be application/json");
    return;
  }

  let body: string;
  try {
    body = await readBody(req, MEDIA_REQUEST_BODY_MAX_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      sendText(res, 413, "Request body too large");
      return;
    }
    sendText(res, 400, "Invalid request body");
    return;
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body);
  } catch {
    sendText(res, 400, "Invalid JSON");
    return;
  }

  const envelope = mediaRequestSchema.safeParse(parsedBody);
  if (!envelope.success) {
    sendText(res, 400, "Invalid media request");
    return;
  }

  const abortController = new AbortController();
  const abortFromClient = () => abortController.abort();
  req.on("aborted", abortFromClient);

  try {
    const outcome = await deliver(envelope.data, abortController.signal);
    res.on("close", () => {
      if (!res.writableFinished) abortController.abort();
    });
    await writeMediaDelivery(res, outcome, abortController.signal);
  } catch {
    if (!res.headersSent) {
      sendText(res, 500, "Internal server error");
    }
  } finally {
    req.off("aborted", abortFromClient);
  }
}

export function createWorkerServer(options: WorkerServerOptions): Server {
  const rpcDeadlineMs = options.rpcDeadlineMs ?? DEFAULT_RPC_DEADLINE_MS;
  const deliverMediaImpl = options.deliverMedia ?? deliverMedia;
  const gate =
    options.gate ??
    new OperationGate(
      DEFAULT_MAX_CONCURRENT_OPERATIONS,
      DEFAULT_OPERATION_QUEUE_WAIT_MS,
    );

  const server = createServer(
    {
      cert: options.tls.serverCertPem,
      key: options.tls.serverKeyPem,
      ca: options.tls.caPem,
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
    },
    (req, res) => {
      void handleRequest(req, res);
    },
  );

  async function handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      if (!authorizeRequest(req, res, options.bearerToken)) return;

      const { method, url } = req;
      if (method === "GET" && url === "/health") {
        const snapshot = await options.healthProvider.getSnapshot();
        const parsed = healthPayloadSchema.safeParse(snapshot);
        if (!parsed.success) {
          sendJson(res, 500, { error: "Internal server error" });
          return;
        }
        sendJson(res, 200, parsed.data);
        return;
      }

      if (method !== "POST") {
        sendJson(res, 404, { error: "Not found" });
        return;
      }

      if (url === "/media") {
        await handleMediaRequest(req, res, deliverMediaImpl);
        return;
      }

      if (url !== "/rpc") {
        sendJson(res, 404, { error: "Not found" });
        return;
      }

      if (!hasJsonContentType(req)) {
        sendJson(res, 415, { error: "Content-Type must be application/json" });
        return;
      }

      let body: string;
      try {
        body = await readBody(req, RPC_REQUEST_BODY_MAX_BYTES);
      } catch (err) {
        if (err instanceof BodyTooLargeError) {
          sendJson(res, 413, { error: "Request body too large" });
          return;
        }
        sendJson(res, 400, { error: "Invalid request body" });
        return;
      }

      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(body);
      } catch {
        sendJson(res, 400, { error: "Invalid JSON" });
        return;
      }

      const envelope = rpcRequestSchema.safeParse(parsedBody);
      if (!envelope.success) {
        sendJson(res, 400, { error: "Invalid RPC envelope" });
        return;
      }

      if (!options.registeredOperations.has(envelope.data.op)) {
        sendJson(res, 404, { error: "Unknown operation" });
        return;
      }

      try {
        const outcome = await executeRpcOperation(
          gate,
          rpcDeadlineMs,
          () => options.dispatch(envelope.data.op, envelope.data.input),
        );

        if (outcome.kind === "success") {
          sendJson(res, 200, rpcSuccessResponse(outcome.result));
          return;
        }
        if (outcome.kind === "deadline") {
          sendJson(res, 504, { error: "RPC deadline exceeded" });
          return;
        }
        sendJson(res, 200, rpcErrorResponse(mapExecutionError(outcome.error)));
      } catch (err) {
        if (err instanceof OperationQueueTimeoutError) {
          sendJson(res, 503, { error: "Worker overloaded" });
          return;
        }
        sendJson(res, 500, { error: "Internal server error" });
      }
    } catch {
      if (!res.headersSent) {
        sendJson(res, 500, { error: "Internal server error" });
      }
    }
  }

  return server;
}

export async function listenWorkerServer(
  options: WorkerServerOptions,
): Promise<WorkerServerHandle> {
  const server = createWorkerServer(options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve());
  });

  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : options.port;

  return {
    server,
    port,
    close() {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
