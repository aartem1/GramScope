import { describe, expect, it } from "vitest";
import { verifyBearerToken } from "../worker/auth";

describe("verifyBearerToken", () => {
  const expected = "expected-worker-token";

  it("accepts a matching bearer token", () => {
    expect(verifyBearerToken("Bearer expected-worker-token", expected)).toBe(
      true,
    );
  });

  it("rejects a missing authorization header", () => {
    expect(verifyBearerToken(undefined, expected)).toBe(false);
  });

  it("rejects a wrong token without throwing on unequal lengths", () => {
    expect(verifyBearerToken("Bearer short", expected)).toBe(false);
    expect(
      verifyBearerToken("Bearer expected-worker-token-extra", expected),
    ).toBe(false);
  });
});
