import { readFile } from "node:fs/promises";

export { sessionFingerprint } from "../src/session/fingerprint.js";

export function readEnvKey(content: string, key: string): string | undefined {
  const prefix = `${key}=`;
  for (const line of content.split(/\r?\n/)) {
    if (!line.startsWith(prefix)) continue;
    return line.slice(prefix.length).replace(/^"|"$/g, "");
  }
  return undefined;
}

export async function readEnvFileKey(
  path: string,
  key: string,
): Promise<string | undefined> {
  try {
    return readEnvKey(await readFile(path, "utf8"), key);
  } catch {
    return undefined;
  }
}
