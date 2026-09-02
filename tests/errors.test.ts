import { describe, expect, it } from "vitest";
import { GramScopeError, mediaError } from "@/errors/taxonomy";
import { mapTelegramError } from "@/errors/from-telegram";
import { errorResult } from "@/mcp/tool-result";

class FakeRpcError extends Error {
  constructor(
    public errorMessage: string,
    public code?: number,
  ) {
    super(errorMessage);
  }
}

describe("mapTelegramError", () => {
  it("maps FLOOD_WAIT_42 to RATE_LIMITED with retry seconds", () => {
    const mapped = mapTelegramError(new FakeRpcError("FLOOD_WAIT_42", 420));
    expect(mapped.code).toBe("RATE_LIMITED");
    expect(mapped.retryAfterSeconds).toBe(42);
    expect(mapped.toStructured().retry_after_seconds).toBe(42);
    expect(mapped.toStructured().retryable).toBe(true);
  });

  it("marks only transient media failures retryable by default", () => {
    expect(new GramScopeError("PROCESSING_TIMEOUT", "slow").toStructured())
      .toEqual({ code: "PROCESSING_TIMEOUT", message: "slow", retryable: true });
    expect(mediaError("TELEGRAM_DOWNLOAD_FAILED", "transport").toStructured())
      .toEqual({ code: "TELEGRAM_DOWNLOAD_FAILED", message: "transport", retryable: true });
    for (const code of [
      "NO_MEDIA",
      "MEDIA_NOT_FOUND",
      "UNSUPPORTED_MEDIA",
      "INVALID_INPUT",
      "INLINE_LIMIT_EXCEEDED",
    ] as const) {
      expect(new GramScopeError(code, "stable").toStructured()).not.toHaveProperty("retryable");
    }
  });

  it("drops unknown exception messages from structured tool errors", () => {
    expect(JSON.stringify(errorResult(new Error("token=secret-value"))))
      .not.toContain("secret-value");
  });

  it("maps CHANNEL_INVALID to CHANNEL_NOT_FOUND", () => {
    expect(mapTelegramError(new FakeRpcError("CHANNEL_INVALID", 400)).code).toBe(
      "CHANNEL_NOT_FOUND",
    );
  });

  it("maps CHANNEL_PRIVATE to PRIVATE_CHANNEL_NOT_ACCESSIBLE", () => {
    expect(mapTelegramError(new FakeRpcError("CHANNEL_PRIVATE", 400)).code).toBe(
      "PRIVATE_CHANNEL_NOT_ACCESSIBLE",
    );
  });

  it("maps AUTH_KEY_UNREGISTERED to AUTH_REQUIRED", () => {
    expect(
      mapTelegramError(new FakeRpcError("AUTH_KEY_UNREGISTERED", 401)).code,
    ).toBe("AUTH_REQUIRED");
  });

  it("maps a duplicated auth key to AUTH_REQUIRED", () => {
    // Official MTProto code is AUTH_KEY_DUPLICATED; some surfaces echo
    // AUTH_KEY_DUPLICATE. Either means Telegram already invalidated the session.
    for (const code of ["AUTH_KEY_DUPLICATED", "AUTH_KEY_DUPLICATE"]) {
      const mapped = mapTelegramError(new FakeRpcError(code, 406));
      expect(mapped.code).toBe("AUTH_REQUIRED");
      expect(mapped.message).toContain(code);
    }
  });

  it("maps the folder-editing wire rules to INVALID_INPUT", () => {
    // folder-edit.ts rejects an over-long title and an empty include list
    // before the call. These entries keep the wire-level answer actionable if
    // a measured limit moves: without them SAFE_CODE reports an
    // INTERNAL_ERROR, which tells a caller neither the rule nor the fix.
    for (const code of ["MESSAGE_TOO_LONG", "FILTER_INCLUDE_EMPTY"]) {
      expect(mapTelegramError(new FakeRpcError(code, 400)).code).toBe(
        "INVALID_INPUT",
      );
    }
  });

  it("passes a GramScopeError through unchanged", () => {
    const original = new GramScopeError("INVALID_CURSOR", "bad cursor");
    expect(mapTelegramError(original)).toBe(original);
  });

  it("falls back to INTERNAL_ERROR for unknown failures", () => {
    expect(mapTelegramError(new Error("something else")).code).toBe(
      "INTERNAL_ERROR",
    );
  });

  it("never leaks the original message for unknown failures", () => {
    const mapped = mapTelegramError(new Error("session=SECRETVALUE"));
    expect(mapped.message).not.toContain("SECRETVALUE");
  });

  it("passes through an unmapped but well-formed Telegram code", () => {
    const mapped = mapTelegramError(new FakeRpcError("SOME_UNKNOWN_ERROR", 400));
    expect(mapped.code).toBe("INTERNAL_ERROR");
    expect(mapped.message).toContain("SOME_UNKNOWN_ERROR");
  });

  it("never echoes an errorMessage that is free text rather than a code", () => {
    const mapped = mapTelegramError(
      new FakeRpcError("unexpected: session=SECRETVALUE", 500),
    );
    expect(mapped.code).toBe("INTERNAL_ERROR");
    expect(mapped.message).not.toContain("SECRETVALUE");
  });

  // teleproto's `_getInputEntity` swallows the CHANNEL_INVALID that
  // `channels.getChannels(accessHash: 0)` returns and rethrows this instead, so
  // the failure reaches us with no errorMessage to classify. Reproduced
  // verbatim from node_modules/teleproto/client/users.js.
  const unresolved = () =>
    new Error(
      `Could not find the input entity for ${JSON.stringify({ channelId: "1006503122" })}.
         Please read https://` +
        "docs.teleproto.dev/concepts/entities to" +
        " find out more details.",
    );

  it("maps teleproto's unclassifiable entity-resolution failure to CHANNEL_NOT_FOUND", () => {
    const mapped = mapTelegramError(unresolved());
    expect(mapped.code).toBe("CHANNEL_NOT_FOUND");
    // A bare marked id for an unjoined channel is the case that produces it,
    // so the message has to say what to pass instead.
    expect(mapped.message).toMatch(/username/i);
  });

  it("does not echo teleproto's own message back to the caller", () => {
    expect(mapTelegramError(unresolved()).message).not.toContain(
      "docs.teleproto.dev",
    );
  });

  it("leaves every classifiable failure during resolution with its own code", () => {
    // The narrowness that matters: a rate limit, an auth failure or a private
    // channel raised by the same getEntity call must not become NOT_FOUND.
    expect(mapTelegramError(new FakeRpcError("FLOOD_WAIT_30", 420)).code).toBe(
      "RATE_LIMITED",
    );
    expect(
      mapTelegramError(new FakeRpcError("AUTH_KEY_UNREGISTERED", 401)).code,
    ).toBe("AUTH_REQUIRED");
    expect(mapTelegramError(new FakeRpcError("CHANNEL_PRIVATE", 400)).code).toBe(
      "PRIVATE_CHANNEL_NOT_ACCESSIBLE",
    );
    // A transport failure carries no errorMessage either, but it is not an
    // unresolved peer and must stay INTERNAL_ERROR.
    expect(
      mapTelegramError(
        Object.assign(new Error("connect ECONNREFUSED 149.154.167.51:443"), {
          code: "ECONNREFUSED",
          syscall: "connect",
        }),
      ).code,
    ).toBe("INTERNAL_ERROR");
    expect(mapTelegramError(new Error("Not connected")).code).toBe(
      "INTERNAL_ERROR",
    );
  });

  it("does not resolve inherited Object.prototype names as error codes", () => {
    for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
      const mapped = mapTelegramError(new FakeRpcError(name, 400));
      expect(typeof mapped.code).toBe("string");
      expect(mapped.code).toBe("INTERNAL_ERROR");
    }
  });
});
