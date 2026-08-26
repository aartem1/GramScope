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

describe("upsertEnvFile durability", () => {
  async function tmpFile() {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "gramscope-"));
    return { dir, file: join(dir, ".env.local") };
  }

  it("leaves no temporary file behind", async () => {
    const { readdir, writeFile } = await import("node:fs/promises");
    const { upsertEnvFile } = await import("../scripts/env-file");
    const { dir, file } = await tmpFile();

    await writeFile(file, "A=1\n", { mode: 0o600 });
    await upsertEnvFile(file, "B", "2");

    expect(await readdir(dir)).toEqual([".env.local"]);
  });

  it("never truncates the live file while writing", async () => {
    // The property that matters: the path must never be observable in a
    // shrunken state, because an interrupt at that instant destroys
    // TELEGRAM_SESSION, which costs an interactive Telegram login to redo.
    // Truncate-then-write is observable; write-temp-then-rename is not.
    const { writeFile, stat, readdir } = await import("node:fs/promises");
    const { spawn } = await import("node:child_process");
    const { dir, file } = await tmpFile();

    const original = `TELEGRAM_SESSION=${"s".repeat(4096)}\n`;
    await writeFile(file, original, { mode: 0o600 });
    const originalSize = (await stat(file)).size;

    const child = spawn(
      "npx",
      ["--no-install", "tsx", "scripts/env-file.ts", file, "BIG"],
      { stdio: ["pipe", "ignore", "ignore"] },
    );
    child.stdin.write("y".repeat(60 * 1024 * 1024));
    child.stdin.end();

    let sawShrink = false;
    let sawTemp = false;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && child.exitCode === null) {
      const size = (await stat(file).catch(() => ({ size: -1 }))).size;
      if (size >= 0 && size < originalSize) sawShrink = true;
      const entries = await readdir(dir).catch(() => []);
      if (entries.some((e) => e !== ".env.local")) sawTemp = true;
      if (sawShrink || sawTemp) break;
      await new Promise((resolve) => setImmediate(resolve));
    }

    child.kill("SIGKILL");
    await new Promise((resolve) => child.on("exit", resolve));

    // Non-vacuous: we must have actually caught the write in progress.
    expect(
      sawShrink || sawTemp,
      "never observed the write in progress; the test proves nothing",
    ).toBe(true);
    expect(sawShrink, "the live file was truncated mid-write").toBe(false);
  }, 40_000);

  it("keeps mode 600 on the replaced file", async () => {
    const { writeFile, stat } = await import("node:fs/promises");
    const { upsertEnvFile } = await import("../scripts/env-file");
    const { file } = await tmpFile();

    await writeFile(file, "A=1\n", { mode: 0o644 });
    await upsertEnvFile(file, "A", "2");

    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});
