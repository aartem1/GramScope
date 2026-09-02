import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

export type LoginTarget = "local" | "production";

/**
 * Short non-secret id for comparing two session strings without printing them.
 * Equal fingerprints mean the same auth key is mounted in two places — the
 * condition that produces AUTH_KEY_DUPLICATED.
 */
export function sessionFingerprint(session: string): string {
  return createHash("sha256").update(session).digest("hex").slice(0, 16);
}

export function parseLoginTarget(argv: string[]): LoginTarget {
  const at = argv.indexOf("--target");
  if (at === -1) {
    throw new Error(
      "Pass --target local or --target production. " +
        "Local and Vercel must never share one TELEGRAM_SESSION string.",
    );
  }
  const value = argv[at + 1];
  if (value !== "local" && value !== "production") {
    throw new Error(`Unknown --target ${value ?? "(missing)"}; expected local or production`);
  }
  return value;
}

export function envTargetPath(argv: string[]): string | undefined {
  const at = argv.indexOf("--write-env");
  return at === -1 ? undefined : argv[at + 1];
}

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

/**
 * Replace TELEGRAM_SESSION in Vercel production without echoing the value.
 * Matches the provision.sh stdin pattern so the string never hits the terminal.
 */
export async function publishProductionSession(session: string): Promise<void> {
  await runCaptured("vercel", ["env", "rm", "TELEGRAM_SESSION", "production", "--yes"], {
    allowFailure: true,
  });
  await runWithStdin(
    "vercel",
    ["env", "add", "TELEGRAM_SESSION", "production"],
    session,
  );
}

async function runCaptured(
  command: string,
  args: string[],
  opts: { allowFailure?: boolean } = {},
): Promise<void> {
  const result = await new Promise<{ code: number | null; stderr: string }>(
    (resolve) => {
      const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("close", (code) => resolve({ code, stderr }));
    },
  );
  if ((result.code ?? 1) !== 0 && !opts.allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
}

async function runWithStdin(
  command: string,
  args: string[],
  stdin: string,
): Promise<void> {
  const result = await new Promise<{ code: number | null; stderr: string }>(
    (resolve) => {
      const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.stdin.write(stdin);
      child.stdin.end();
      child.on("close", (code) => resolve({ code, stderr }));
    },
  );
  if ((result.code ?? 1) !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
}
