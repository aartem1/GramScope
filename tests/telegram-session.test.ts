import { describe, expect, it } from "vitest";
import { sessionFingerprint } from "@/session/fingerprint";

describe("sessionFingerprint", () => {
  it("is stable for the same session and differs across sessions", () => {
    expect(sessionFingerprint("alpha")).toBe(sessionFingerprint("alpha"));
    expect(sessionFingerprint("alpha")).not.toBe(sessionFingerprint("beta"));
    expect(sessionFingerprint("alpha")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("readEnvKey", () => {
  it("reads an unquoted dotenv value and strips vercel pull quotes", async () => {
    const { readEnvKey } = await import("../src/cli/env");
    expect(readEnvKey("A=1\nTELEGRAM_SESSION=abc\n", "TELEGRAM_SESSION")).toBe(
      "abc",
    );
    expect(
      readEnvKey('TELEGRAM_SESSION="abc"\n', "TELEGRAM_SESSION"),
    ).toBe("abc");
  });
});
