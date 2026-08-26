import { describe, expect, it } from "vitest";
import { GramScopeError } from "@/errors/taxonomy";
import { mapTelegramError } from "@/errors/from-telegram";

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
});
