import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stdin, stdout, argv, env } from "node:process";
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

function argValue(flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
}

/**
 * Creates a Telegram StringSession for exactly one mount point.
 *
 * --target local       → writes TELEGRAM_SESSION into .env.local only
 * --target production  → publishes TELEGRAM_SESSION to Vercel production only
 *
 * Optional non-interactive inputs for agent/CI-assisted login:
 *   --phone +1...
 *   --code-file /path/to/file   (script waits until this file contains the code)
 *   --password '2fa'            (blank / omit when unset)
 *
 * Never copy a production session into .env.local, and never push the local
 * session to Vercel: Telegram invalidates the auth key (AUTH_KEY_DUPLICATED)
 * when the same string opens two main-DC connections.
 */
async function main() {
  const target = parseLoginTarget(argv);
  const apiId = Number(env.TELEGRAM_API_ID);
  const apiHash = env.TELEGRAM_API_HASH;
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

  const phone = argValue("--phone") ?? env.TELEGRAM_LOGIN_PHONE;
  const codeFile = argValue("--code-file") ?? env.TELEGRAM_LOGIN_CODE_FILE;
  const password = argValue("--password") ?? env.TELEGRAM_LOGIN_PASSWORD ?? "";

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
      phoneNumber: async () =>
        phone ?? (await rl.question("Phone number (with country code): ")),
      phoneCode: async () => {
        if (codeFile) return waitForCodeFile(codeFile);
        return rl.question("Login code from Telegram: ");
      },
      password: async () => {
        if (phone || codeFile) return password;
        return rl.question("Two-factor password (blank if unset): ");
      },
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

async function waitForCodeFile(path: string): Promise<string> {
  console.log(`Waiting for login code in ${path} ...`);
  await writeFile(`${path}.waiting`, "waiting_for_code\n", { mode: 0o600 });
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      const code = (await readFile(path, "utf8")).trim();
      if (code) {
        await rm(`${path}.waiting`).catch(() => undefined);
        await rm(path).catch(() => undefined);
        return code;
      }
    } catch {
      // not yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for login code in ${path}`);
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
