import { createInterface } from "node:readline/promises";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { stdin, stdout, argv, env } from "node:process";
import { loginTelegramSession } from "../src/telegram/client.js";
import { sessionFingerprint } from "../src/session/fingerprint.js";
import { upsertEnvFile } from "./env-file.js";
import {
  parseWorkerLoginTarget,
  resolveWorkerEnvPath,
} from "./worker-login-args.js";

const rl = createInterface({ input: stdin, output: stdout });

function argValue(flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
}

/**
 * Creates a Telegram StringSession for the VPS worker only.
 *
 * --target worker       required
 * --write-env <path>    optional; default /etc/gramscope/worker.env
 *
 * Credentials come from the environment. Phone, code and password may use
 * flags or interactive fallback. The session string is written atomically and
 * never printed.
 */
async function main() {
  parseWorkerLoginTarget(argv);
  const writeEnv = resolveWorkerEnvPath(argv);

  const apiId = Number(env.TELEGRAM_API_ID);
  const apiHash = env.TELEGRAM_API_HASH;
  if (!Number.isInteger(apiId) || !apiHash) {
    throw new Error(
      "TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in the worker environment.",
    );
  }

  const phone = argValue("--phone") ?? env.TELEGRAM_LOGIN_PHONE;
  const codeFile = argValue("--code-file") ?? env.TELEGRAM_LOGIN_CODE_FILE;
  const password = argValue("--password") ?? env.TELEGRAM_LOGIN_PASSWORD ?? "";

  console.log("Creating a worker Telegram session.");
  console.log(
    "The session is written to the worker environment file and is never shown.\n",
  );

  const session = await loginTelegramSession(apiId, apiHash, {
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

  const fingerprint = sessionFingerprint(session);
  console.log(`\nLogin succeeded (fingerprint ${fingerprint}).\n`);

  await upsertEnvFile(writeEnv, "TELEGRAM_SESSION", session);
  console.log(`Session stored in ${writeEnv} (not shown here, by design).`);
  console.log("Restart gramscope-worker after updating the environment file.\n");
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

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  })
  .finally(() => {
    rl.close();
  });
