import { describe, expect, it } from "vitest";
import { upsertEnvLine } from "../scripts/env-file";

describe("upsertEnvLine", () => {
  it("replaces an existing key in place", () => {
    const out = upsertEnvLine("A=1\nB=2\nC=3\n", "B", "new");
    expect(out).toBe("A=1\nB=new\nC=3\n");
  });

  it("appends a key that is absent", () => {
    expect(upsertEnvLine("A=1\n", "B", "2")).toBe("A=1\nB=2\n");
  });

  it("does not match a key that is only a prefix of another", () => {
    const out = upsertEnvLine("TELEGRAM_API_ID=1\n", "TELEGRAM_API", "x");
    expect(out).toBe("TELEGRAM_API_ID=1\nTELEGRAM_API=x\n");
  });

  it("replaces a key whose current value is empty", () => {
    expect(upsertEnvLine("TELEGRAM_SESSION=\n", "TELEGRAM_SESSION", "s")).toBe(
      "TELEGRAM_SESSION=s\n",
    );
  });

  it("handles content with no trailing newline", () => {
    expect(upsertEnvLine("A=1", "B", "2")).toBe("A=1\nB=2\n");
  });

  it("handles empty content", () => {
    expect(upsertEnvLine("", "A", "1")).toBe("A=1\n");
  });

  it("preserves comments and blank lines", () => {
    const out = upsertEnvLine("# note\n\nA=1\n", "A", "2");
    expect(out).toBe("# note\n\nA=2\n");
  });

  it("writes the value verbatim, including = and spaces", () => {
    const out = upsertEnvLine("A=1\n", "A", "x=y z");
    expect(out).toBe("A=x=y z\n");
  });

  it("replaces only the first occurrence of a duplicated key", () => {
    expect(upsertEnvLine("A=1\nA=2\n", "A", "3")).toBe("A=3\nA=2\n");
  });
});

describe("upsertEnvFile", () => {
  it("leaves the file readable only by its owner", async () => {
    const { mkdtemp, writeFile, stat } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { upsertEnvFile } = await import("../scripts/env-file");

    const dir = await mkdtemp(join(tmpdir(), "gramscope-"));
    const file = join(dir, ".env.local");
    // Deliberately start world-readable: the helper must not trust that the
    // caller created the file correctly, because it stores a Telegram session.
    await writeFile(file, "A=1\n", { mode: 0o644 });

    await upsertEnvFile(file, "TELEGRAM_SESSION", "s");

    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("creates a missing file with the session already restricted", async () => {
    const { mkdtemp, stat, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { upsertEnvFile } = await import("../scripts/env-file");

    const dir = await mkdtemp(join(tmpdir(), "gramscope-"));
    const file = join(dir, ".env.local");

    await upsertEnvFile(file, "TELEGRAM_SESSION", "s");

    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, "utf8")).toBe("TELEGRAM_SESSION=s\n");
  });
});
