import { Agent, fetch as undiciFetch } from "undici";
import type { WorkerClientConfig } from "../config";
import { GramScopeError } from "../errors/taxonomy";
import type { OperationRegistry } from "./dispatch";
import { isWriterOperation } from "./writer-ops";
import {
  DEFAULT_RPC_DEADLINE_MS,
  gramScopeErrorFromWire,
  rpcErrorResponseSchema,
  rpcSuccessResponseSchema,
} from "./wire";

export type RemoteDispatchOptions = {
  operations: OperationRegistry;
  config: WorkerClientConfig;
  deadlineMs?: number;
  fetchImpl?: typeof undiciFetch;
  agent?: Agent;
};

export type UpstreamUnavailableError = GramScopeError & {
  noResponseReceived: boolean;
};

function upstreamUnavailable(
  message: string,
  noResponseReceived: boolean,
): UpstreamUnavailableError {
  const error = new GramScopeError(
    "UPSTREAM_UNAVAILABLE",
    message,
    undefined,
    true,
  ) as UpstreamUnavailableError;
  error.noResponseReceived = noResponseReceived;
  return error;
}

function isUpstreamUnavailable(
  error: unknown,
): error is UpstreamUnavailableError {
  return (
    error instanceof GramScopeError &&
    error.code === "UPSTREAM_UNAVAILABLE" &&
    "noResponseReceived" in error &&
    typeof (error as UpstreamUnavailableError).noResponseReceived === "boolean"
  );
}

function createWorkerAgent(config: WorkerClientConfig): Agent {
  return new Agent({
    connect: {
      ca: config.caPem,
      cert: config.clientCertPem,
      key: config.clientKeyPem,
      minVersion: "TLSv1.3",
      rejectUnauthorized: true,
    },
  });
}

/**
 * Remote dispatcher: POST /rpc over mTLS+bearer, map wire errors, retry
 * read-only ops once when no response byte was received.
 */
export function createRemoteDispatcher(options: RemoteDispatchOptions) {
  const deadlineMs = options.deadlineMs ?? DEFAULT_RPC_DEADLINE_MS;
  const fetchImpl = options.fetchImpl ?? undiciFetch;
  const agent = options.agent ?? createWorkerAgent(options.config);
  const rpcUrl = `${options.config.workerUrl.replace(/\/$/, "")}/rpc`;

  async function dispatchOnce(op: string, input: unknown): Promise<unknown> {
    const definition = options.operations[op];
    if (definition === undefined) {
      throw new GramScopeError(
        "INTERNAL_ERROR",
        `Unknown operation '${op}'.`,
      );
    }

    const parsedInput = definition.input.parse(input);

    let response: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      response = await fetchImpl(rpcUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.config.workerToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ op, input: parsedInput }),
        dispatcher: agent,
        signal: AbortSignal.timeout(deadlineMs),
      });
    } catch {
      throw upstreamUnavailable(
        "Worker request failed before a response was received.",
        true,
      );
    }

    let bodyText: string;
    try {
      bodyText = await response.text();
    } catch {
      throw upstreamUnavailable(
        "Worker response could not be read.",
        false,
      );
    }

    if (response.status < 200 || response.status >= 300) {
      throw upstreamUnavailable(
        `Worker returned HTTP ${response.status}.`,
        false,
      );
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(bodyText);
    } catch {
      throw upstreamUnavailable("Worker returned invalid JSON.", false);
    }

    const success = rpcSuccessResponseSchema.safeParse(parsedBody);
    if (success.success) {
      const parsedOutput = definition.output.safeParse(success.data.result);
      if (!parsedOutput.success) {
        throw new GramScopeError(
          "INTERNAL_ERROR",
          "Operation produced an invalid result.",
        );
      }
      return success.data.result;
    }

    const failure = rpcErrorResponseSchema.safeParse(parsedBody);
    if (failure.success) {
      throw gramScopeErrorFromWire(failure.data.error);
    }

    throw upstreamUnavailable("Worker returned an unexpected RPC envelope.", false);
  }

  return async function dispatch(
    op: string,
    input: unknown,
  ): Promise<unknown> {
    const maxAttempts = isWriterOperation(op) ? 1 : 2;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await dispatchOnce(op, input);
      } catch (error) {
        const canRetry =
          attempt < maxAttempts - 1 &&
          isUpstreamUnavailable(error) &&
          error.noResponseReceived;

        if (!canRetry) {
          if (isUpstreamUnavailable(error)) {
            throw new GramScopeError(
              error.code,
              error.message,
              error.retryAfterSeconds,
              error.retryable,
            );
          }
          throw error;
        }
      }
    }

    throw new GramScopeError(
      "UPSTREAM_UNAVAILABLE",
      "Worker request failed before a response was received.",
      undefined,
      true,
    );
  };
}

export function createWorkerFetchAgent(config: WorkerClientConfig): Agent {
  return createWorkerAgent(config);
}
