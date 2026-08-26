import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";

const rl = createInterface({ input: stdin, output: stdout });

async function main() {
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;
  if (!Number.isInteger(apiId) || !apiHash) {
    throw new Error(
      "Set TELEGRAM_API_ID and TELEGRAM_API_HASH before running this script",
    );
  }

  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 3,
  });

  await client.start({
    phoneNumber: () => rl.question("Phone number (with country code): "),
    phoneCode: () => rl.question("Login code from Telegram: "),
    password: () => rl.question("Two-factor password (blank if unset): "),
    onError: (err) => {
      console.error("Login failed:", err.message);
    },
  });

  console.log("\nLogin succeeded.\n");
  console.log(
    "Copy the session string below into TELEGRAM_SESSION. It grants FULL",
  );
  console.log("access to this Telegram account — treat it like a password.\n");
  console.log(client.session.save());
  console.log(
    "\nStore it now with:  vercel env add TELEGRAM_SESSION production\n",
  );

  await client.disconnect();
  rl.close();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
