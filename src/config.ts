export type Config = {
  telegramApiId: number;
  telegramApiHash: string;
  telegramSession: string;
  workosIssuer: string;
  workosJwksUrl: string;
  ownerUserId: string;
};

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function loadConfig(env: Env = process.env): Config {
  const rawApiId = required(env, "TELEGRAM_API_ID");
  const telegramApiId = Number(rawApiId);
  if (!Number.isInteger(telegramApiId)) {
    throw new Error("TELEGRAM_API_ID must be an integer");
  }
  return {
    telegramApiId,
    telegramApiHash: required(env, "TELEGRAM_API_HASH"),
    telegramSession: required(env, "TELEGRAM_SESSION"),
    workosIssuer: required(env, "WORKOS_ISSUER"),
    workosJwksUrl: required(env, "WORKOS_JWKS_URL"),
    ownerUserId: required(env, "OWNER_USER_ID"),
  };
}
