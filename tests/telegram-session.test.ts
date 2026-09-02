import { describe, expect, it } from "vitest";
import {
  parseLoginTarget,
  readEnvKey,
  sessionFingerprint,
} from "../scripts/telegram-session";

describe("sessionFingerprint", () => {
  it("is stable for the same session and differs across sessions", () => {
    expect(sessionFingerprint("alpha")).toBe(sessionFingerprint("alpha"));
    expect(sessionFingerprint("alpha")).not.toBe(sessionFingerprint("beta"));
    expect(sessionFingerprint("alpha")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("parseLoginTarget", () => {
  it("requires an explicit local or production target", () => {
    expect(parseLoginTarget(["--target", "local"])).toBe("local");
    expect(parseLoginTarget(["--target", "production"])).toBe("production");
    expect(() => parseLoginTarget([])).toThrow(/--target local or --target production/);
    expect(() => parseLoginTarget(["--target", "staging"])).toThrow(/Unknown --target/);
  });
});

describe("readEnvKey", () => {
  it("reads an unquoted dotenv value and strips vercel pull quotes", () => {
    expect(readEnvKey("A=1\nTELEGRAM_SESSION=abc\n", "TELEGRAM_SESSION")).toBe(
      "abc",
    );
    expect(
      readEnvKey('TELEGRAM_SESSION="abc"\n', "TELEGRAM_SESSION"),
    ).toBe("abc");
  });
});
