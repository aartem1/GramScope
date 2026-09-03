import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

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
 * Reads, upserts, and atomically replaces the file, always at mode 600.
 * Creates it if absent.
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

  // Write a sibling, then rename over the target. rename is atomic within a
  // filesystem, so the path is never observable in a truncated state: an
  // interrupt leaves either the whole old document or the whole new one.
  // Truncate-then-write would lose TELEGRAM_SESSION, and regenerating that
  // costs an interactive Telegram login.
  //
  // The temporary file is created at mode 600 and rename carries that mode
  // onto the target, which also repairs a file that was created too openly.
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    await writeFile(tmp, upsertEnvLine(content, key, value), { mode: 0o600 });
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
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

if (require.main === module) {
  void (async () => {
    const [path, key] = process.argv.slice(2);
    if (!path || !key) {
      console.error("usage: env-file.ts <path> <KEY>  (value on stdin)");
      process.exit(1);
    }
    const value = (await readStdin()).replace(/\r?\n$/, "");
    await upsertEnvFile(path, key, value);
  })().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
