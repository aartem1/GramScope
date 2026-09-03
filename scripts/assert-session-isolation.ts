import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readEnvFileKey,
  readEnvKey,
} from "../src/cli/env";
import { sessionFingerprint } from "../src/session/fingerprint";

const ROOT = join(import.meta.dirname, "..");
const LOCAL_ENV = join(ROOT, ".env.local");

/**
 * Fails when .env.local and Vercel production share the same TELEGRAM_SESSION.
 * That shared mount is what triggers AUTH_KEY_DUPLICATED.
 */
async function main() {
  const localSession = await readEnvFileKey(LOCAL_ENV, "TELEGRAM_SESSION");
  if (!localSession) {
    console.log("No local TELEGRAM_SESSION — nothing to compare.");
    return;
  }

  const productionSession = await pullProductionSession();
  if (!productionSession) {
    console.log("No Vercel production TELEGRAM_SESSION — nothing to compare.");
    return;
  }

  const localFp = sessionFingerprint(localSession);
  const productionFp = sessionFingerprint(productionSession);
  if (localFp === productionFp) {
    console.error(
      "TELEGRAM_SESSION isolation failed: .env.local and Vercel production " +
        `share fingerprint ${localFp}.`,
    );
    console.error(
      "Create separate logins: npm run telegram:login:production, then " +
        "npm run telegram:login:local. Never copy one session into the other.",
    );
    process.exit(1);
  }

  console.log(
    `TELEGRAM_SESSION isolation ok (local ${localFp}, production ${productionFp}).`,
  );
}

async function pullProductionSession(): Promise<string | undefined> {
  const dir = await mkdtemp(join(tmpdir(), "gramscope-session-"));
  const file = join(dir, ".env.production.check");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "vercel",
        ["env", "pull", file, "--environment", "production", "--yes"],
        { stdio: "ignore" },
      );
      child.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error("vercel env pull failed")),
      );
    });
    return readEnvKey(await readFile(file, "utf8"), "TELEGRAM_SESSION");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
