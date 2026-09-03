import { Agent, fetch as undiciFetch } from "undici";
import type { WorkerClientConfig } from "../config";
import { createWorkerFetchAgent } from "../ops/remote";
import { mediaRequestSchema, type MediaRequestBody } from "./wire";

export type WorkerMediaFetchOptions = {
  config: WorkerClientConfig;
  body: MediaRequestBody;
  signal?: AbortSignal;
  agent?: Agent;
  fetchImpl?: typeof undiciFetch;
};

let sharedAgent: Agent | undefined;

export function getWorkerMediaAgent(config: WorkerClientConfig): Agent {
  sharedAgent ??= createWorkerFetchAgent(config);
  return sharedAgent;
}

/**
 * POST /media over mTLS+bearer. Returns the worker response for the route to
 * copy through; does not retry (streaming must not be duplicated).
 */
export async function fetchMediaFromWorker(
  options: WorkerMediaFetchOptions,
): Promise<Response> {
  const parsedBody = mediaRequestSchema.parse(options.body);
  const agent = options.agent ?? getWorkerMediaAgent(options.config);
  const fetchImpl = options.fetchImpl ?? undiciFetch;
  const mediaUrl = `${options.config.workerUrl.replace(/\/$/, "")}/media`;

  try {
    const response = await fetchImpl(mediaUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.config.workerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(parsedBody),
      dispatcher: agent,
      signal: options.signal,
    });
    return response as unknown as Response;
  } catch (error) {
    if (options.signal?.aborted) {
      throw error;
    }
    return new Response("Media upstream unavailable", { status: 502 });
  }
}
