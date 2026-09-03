import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

async function collectTypeScriptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      files.push(...(await collectTypeScriptFiles(path)));
      continue;
    }
    if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

describe("teleproto import isolation", () => {
  it("allows teleproto only in src/telegram/client.ts", async () => {
    const root = join(import.meta.dirname, "..");
    const files = [
      ...(await collectTypeScriptFiles(join(root, "src"))),
      ...(await collectTypeScriptFiles(join(root, "worker"))),
      ...(await collectTypeScriptFiles(join(root, "scripts"))),
    ];

    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith("src/telegram/client.ts")) continue;
      const content = await readFile(file, "utf8");
      if (/from\s+["']teleproto/.test(content) || /import\s*\(\s*["']teleproto/.test(content)) {
        offenders.push(file.replace(`${root}/`, ""));
      }
    }

    expect(offenders).toEqual([]);
  });
});
