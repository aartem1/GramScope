import { describe, expect, it } from "vitest";
import { GramScopeError } from "@/errors/taxonomy";
import {
  gramScopeErrorFromWire,
  rpcErrorResponse,
  rpcSuccessResponse,
  serializeGramScopeError,
} from "@/ops/wire";

describe("worker wire serialization", () => {
  it("serializes success responses", () => {
    expect(rpcSuccessResponse({ n: 1 })).toEqual({
      ok: true,
      result: { n: 1 },
    });
  });

  it("serializes GramScopeError including retryable false and retryAfterSeconds", () => {
    const error = new GramScopeError(
      "RATE_LIMITED",
      "slow down",
      42,
      true,
    );
    expect(serializeGramScopeError(error)).toEqual({
      code: "RATE_LIMITED",
      message: "slow down",
      retryable: true,
      retryAfterSeconds: 42,
    });

    const nonRetryable = new GramScopeError(
      "INVALID_INPUT",
      "bad input",
      undefined,
      false,
    );
    expect(serializeGramScopeError(nonRetryable)).toEqual({
      code: "INVALID_INPUT",
      message: "bad input",
      retryable: false,
    });
  });

  it("wraps errors in ok:false responses", () => {
    const error = new GramScopeError("CHANNEL_NOT_FOUND", "missing");
    expect(rpcErrorResponse(error)).toEqual({
      ok: false,
      error: {
        code: "CHANNEL_NOT_FOUND",
        message: "missing",
        retryable: false,
      },
    });
  });

  it("downgrades unknown wire codes to INTERNAL_ERROR", () => {
    const rebuilt = gramScopeErrorFromWire({
      code: "NOT_A_REAL_CODE",
      message: "nope",
      retryable: true,
    });
    expect(rebuilt.code).toBe("INTERNAL_ERROR");
    expect(rebuilt.message).toBe("nope");
    expect(rebuilt.retryable).toBe(true);
  });
});
