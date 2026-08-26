import { createInterface } from "node:readline/promises";
import { stdin, stdout, argv } from "node:process";
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { upsertEnvFile } from "./env-file";

const rl = createInterface({ input: stdin, output: stdout });

/**
 * `--write-env <path>` stores the session in that dotenv file instead of
 * printing it. The wizard uses this so the string never reaches the terminal,
 * the shell's history, or a shell variable — it goes from Telegram straight
 * into a mode-600 file. Without the flag the session is printed, which is
 * still what you want when running this script on its own.
 */
function envTarget(): string | undefined {
  const at = argv.indexOf("--write-env");
  return at === -1 ? undefined : argv[at + 1];
}

async function main() {
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;
  if (!Number.isInteger(apiId) || !apiHash) {
    throw new Error(
      "TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in .env.local. " +
        "Run ./scripts/provision.sh first, which creates it.",
    );
  }

  const target = envTarget();
  if (argv.includes("--write-env") && !target) {
    throw new Error("--write-env requires a file path");
  }

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

    console.log("\nLogin succeeded.\n");

    if (target) {
      await upsertEnvFile(target, "TELEGRAM_SESSION", session);
      console.log(`Session stored in ${target} (not shown here, by design).`);
      console.log(
        "It grants FULL access to this Telegram account — treat that file",
      );
      console.log("like a password.\n");
    } else {
      console.log(
        "Copy the session string below into TELEGRAM_SESSION. It grants FULL",
      );
      console.log(
        "access to this Telegram account — treat it like a password.\n",
      );
      console.log(session);
      console.log("");
    }
  } finally {
    // Runs on the failure path too, so a failed login does not leave the
    // MTProto connection and the readline handle open.
    await client.disconnect().catch(() => undefined);
    rl.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
