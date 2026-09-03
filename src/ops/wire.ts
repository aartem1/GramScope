import { z } from "zod";
import { GramScopeError, type ErrorCode, ERROR_CODES } from "../errors/taxonomy";

/** Enough for the largest current tool input payloads; not unbounded. */
export const RPC_REQUEST_BODY_MAX_BYTES = 1_048_576;

/** Spec §16: worker `/rpc` deadline stays below Vercel's 60s budget. */
export const DEFAULT_RPC_DEADLINE_MS = 50_000;

export const rpcRequestSchema = z.object({
  op: z.string().min(1),
  input: z.unknown(),
});

export const rpcWireErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  retryAfterSeconds: z.number().optional(),
});

export const rpcSuccessResponseSchema = z.object({
  ok: z.literal(true),
  result: z.unknown(),
});

export const rpcErrorResponseSchema = z.object({
  ok: z.literal(false),
  error: rpcWireErrorSchema,
});

export type RpcWireError = z.output<typeof rpcWireErrorSchema>;
export type RpcSuccessResponse = z.output<typeof rpcSuccessResponseSchema>;
export type RpcErrorResponse = z.output<typeof rpcErrorResponseSchema>;

const KNOWN_CODES = new Set<string>(ERROR_CODES);

export function serializeGramScopeError(error: GramScopeError): RpcWireError {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    ...(error.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: error.retryAfterSeconds }
      : {}),
  };
}

export function rpcErrorResponse(error: GramScopeError): RpcErrorResponse {
  return { ok: false, error: serializeGramScopeError(error) };
}

export function rpcSuccessResponse(result: unknown): RpcSuccessResponse {
  return { ok: true, result };
}

/**
 * Reconstructs a GramScopeError from a worker wire payload. Unknown codes
 * downgrade to INTERNAL_ERROR so a newer worker cannot inject untrusted codes.
 */
export function gramScopeErrorFromWire(error: RpcWireError): GramScopeError {
  const code = KNOWN_CODES.has(error.code)
    ? (error.code as ErrorCode)
    : "INTERNAL_ERROR";
  return new GramScopeError(
    code,
    error.message,
    error.retryAfterSeconds,
    error.retryable,
  );
}
