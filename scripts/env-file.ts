import { chmod, readFile, writeFile } from "node:fs/promises";

/**
 * Replaces `KEY=...` in a dotenv file's contents, or appends it when absent.
 *
 * Kept separate from the wizard and covered by tests because this is where a
 * bug is most expensive: TELEGRAM_SESSION costs an interactive Telegram login
 * to regenerate, so silently dropping or corrupting a line is not recoverable
 * by re-running anything.
 *
 * The value is written verbatim — dotenv values are not shell-quoted here, and
 * every value this project stores (ids, hashes, URLs, a base64 session) is
 * free of newlines.
 */
export function upsertEnvLine(
  content: string,
  key: string,
  value: string,
): string {
  const lines = content.length === 0 ? [] : content.replace(/\n$/, "").split("\n");
  const prefix = `${key}=`;
  const index = lines.findIndex((line) => line.startsWith(prefix));

  if (index === -1) lines.push(prefix + value);
  else lines[index] = prefix + value;

  return lines.join("\n") + "\n";
}

/**
 * Reads, upserts, and writes back, keeping the file at mode 600. Creates the
 * file restricted if it does not exist yet.
 */
export async function upsertEnvFile(
  path: string,
  key: string,
  value: string,
): Promise<void> {
  let content = "";
  try {
    content = await readFile(path, "utf8");
  } catch {
    content = "";
  }
  await writeFile(path, upsertEnvLine(content, key, value), { mode: 0o600 });
  // writeFile's mode applies only when creating, so an existing file keeps
  // whatever permissions it had. This file holds a Telegram session, so
  // narrow it unconditionally rather than trusting how it was created.
  await chmod(path, 0o600);
}

/**
 * CLI: `tsx scripts/env-file.ts <path> <KEY>` with the value on stdin.
 *
 * The value arrives on stdin rather than as an argument so secrets never
 * appear in the process list, where any other user on the machine could read
 * them with `ps`.
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [path, key] = process.argv.slice(2);
  if (!path || !key) {
    console.error("usage: env-file.ts <path> <KEY>  (value on stdin)");
    process.exit(1);
  }
  const value = (await readStdin()).replace(/\r?\n$/, "");
  await upsertEnvFile(path, key, value);
}
