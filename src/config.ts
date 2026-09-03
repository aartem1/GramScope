export type TelegramConfig = {
  telegramApiId: number;
  telegramApiHash: string;
  telegramSession: string;
};

export type WorkerClientConfig = {
  workerUrl: string;
  workerToken: string;
  caPem: string;
  clientCertPem: string;
  clientKeyPem: string;
};

export type Config = {
  workosIssuer: string;
  workosJwksUrl: string;
  ownerUserId: string;
  mediaTokenSecret: Uint8Array;
  /**
   * The resource identifier this server accepts tokens for (the deployed
   * origin + /api/mcp). Required: without it the audience check cannot run,
   * and any other application in the same WorkOS environment would be
   * accepted.
   */
  mcpResourceUrl: string;
  telegram?: TelegramConfig;
  worker?: WorkerClientConfig;
};

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function requiredMediaTokenSecret(env: Env): Uint8Array {
  const encoded = required(env, "MEDIA_TOKEN_SECRET");
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error("MEDIA_TOKEN_SECRET must be base64url without padding");
  }
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.length !== 32) {
    throw new Error("MEDIA_TOKEN_SECRET must decode to exactly 32 bytes");
  }
  return new Uint8Array(bytes);
}

/** Telegram credentials only. Shared by Vercel and the VPS worker. */
export function loadTelegramConfig(env: Env = process.env): TelegramConfig {
  const rawApiId = required(env, "TELEGRAM_API_ID");
  const telegramApiId = Number(rawApiId);
  if (!Number.isInteger(telegramApiId)) {
    throw new Error("TELEGRAM_API_ID must be an integer");
  }
  return {
    telegramApiId,
    telegramApiHash: required(env, "TELEGRAM_API_HASH"),
    telegramSession: required(env, "TELEGRAM_SESSION"),
  };
}

export function isRemoteDispatchEnabled(env: Env = process.env): boolean {
  return Boolean(env.TELEGRAM_WORKER_URL?.trim());
}

function decodeBase64Pem(env: Env, name: string): string {
  const encoded = required(env, name);
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    throw new Error(`${name} must be valid base64`);
  }
  if (!decoded.includes("-----BEGIN")) {
    throw new Error(`${name} must decode to a PEM block`);
  }
  return decoded;
}

/** Worker client credentials for the Vercel half when remote dispatch is on. */
export function loadWorkerClientConfig(
  env: Env = process.env,
): WorkerClientConfig {
  const workerUrl = required(env, "TELEGRAM_WORKER_URL").trim();
  return {
    workerUrl,
    workerToken: required(env, "TELEGRAM_WORKER_TOKEN"),
    caPem: decodeBase64Pem(env, "TELEGRAM_WORKER_CA"),
    clientCertPem: decodeBase64Pem(env, "TELEGRAM_WORKER_CLIENT_CERT"),
    clientKeyPem: decodeBase64Pem(env, "TELEGRAM_WORKER_CLIENT_KEY"),
  };
}

export function loadConfig(env: Env = process.env): Config {
  const common = {
    workosIssuer: required(env, "WORKOS_ISSUER"),
    workosJwksUrl: required(env, "WORKOS_JWKS_URL"),
    ownerUserId: required(env, "OWNER_USER_ID"),
    mcpResourceUrl: required(env, "MCP_RESOURCE_URL"),
    mediaTokenSecret: requiredMediaTokenSecret(env),
  };

  if (isRemoteDispatchEnabled(env)) {
    return { ...common, worker: loadWorkerClientConfig(env) };
  }

  return { ...common, telegram: loadTelegramConfig(env) };
}
