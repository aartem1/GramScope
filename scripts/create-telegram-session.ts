import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stdin, stdout, argv } from "node:process";
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { upsertEnvFile } from "./env-file";
import {
  envTargetPath,
  parseLoginTarget,
  publishProductionSession,
  readEnvFileKey,
  readEnvKey,
  sessionFingerprint,
} from "./telegram-session";

const rl = createInterface({ input: stdin, output: stdout });
const ROOT = join(import.meta.dirname, "..");
const LOCAL_ENV = join(ROOT, ".env.local");

/**
 * Creates a Telegram StringSession for exactly one mount point.
 *
 * --target local       → writes TELEGRAM_SESSION into .env.local only
 * --target production  → publishes TELEGRAM_SESSION to Vercel production only
 *
 * Never copy a production session into .env.local, and never push the local
 * session to Vercel: Telegram invalidates the auth key (AUTH_KEY_DUPLICATED)
 * when the same string opens two main-DC connections.
 */
async function main() {
  const target = parseLoginTarget(argv);
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;
  if (!Number.isInteger(apiId) || !apiHash) {
    throw new Error(
      "TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in .env.local. " +
        "Run ./scripts/provision.sh first, which creates it.",
    );
  }

  const writeEnv = envTargetPath(argv);
  if (argv.includes("--write-env") && !writeEnv) {
    throw new Error("--write-env requires a file path");
  }
  if (target === "production" && writeEnv) {
    throw new Error(
      "--target production refuses --write-env: the production session must " +
        "never be written into a local dotenv file.",
    );
  }

  console.log(
    target === "local"
      ? "Creating a LOCAL-only Telegram session (.env.local)."
      : "Creating a PRODUCTION-only Telegram session (Vercel env).",
  );
  console.log(
    "This login must not be reused for the other target — one StringSession, one mount.\n",
  );

  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 3,
  });

  try {
    await client.start({
      phoneNumber: () => rl.question("Phone number (with country code): "),
      phoneCode: () => rl.question("Login code from Telegram: "),
      password: () => rl.question("Two-factor password (blank if unset): "),
      onError: (err) => {
        console.error("Login failed:", err.message);
      },
    });

    const session = client.session.save();
    if (typeof session !== "string" || session.length === 0) {
      throw new Error("Telegram returned an empty session string");
    }

    const fingerprint = sessionFingerprint(session);
    console.log(`\nLogin succeeded (fingerprint ${fingerprint}).\n`);

    if (target === "local") {
      const path = writeEnv ?? LOCAL_ENV;
      const productionTwin = await readProductionFingerprint();
      if (productionTwin && productionTwin === fingerprint) {
        throw new Error(
          "Refusing to store this session locally: it matches the Vercel " +
            "production fingerprint. Run a fresh login for local use.",
        );
      }
      await upsertEnvFile(path, "TELEGRAM_SESSION", session);
      console.log(`Session stored in ${path} (not shown here, by design).`);
      console.log("It is for LOCAL use only — never push it to Vercel.\n");
    } else {
      const localSession = await readEnvFileKey(LOCAL_ENV, "TELEGRAM_SESSION");
      if (localSession && sessionFingerprint(localSession) === fingerprint) {
        throw new Error(
          "Refusing to publish this session to Vercel: it matches .env.local. " +
            "Run a fresh login for production.",
        );
      }
      await publishProductionSession(session);
      console.log("Session published to Vercel production (not shown here).");
      console.log("It is for Vercel only — never put it in .env.local.\n");
      console.log("Redeploy production so new isolates pick up the value:");
      console.log("  npx vercel redeploy --prod\n");
    }
  } finally {
    await client.disconnect().catch(() => undefined);
    rl.close();
  }
}

async function readProductionFingerprint(): Promise<string | undefined> {
  try {
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
      const session = readEnvKey(await readFile(file, "utf8"), "TELEGRAM_SESSION");
      return session ? sessionFingerprint(session) : undefined;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } catch {
    return undefined;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
