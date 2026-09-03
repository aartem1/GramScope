import { readFile } from "node:fs/promises";
import { loadTelegramConfig } from "../config";

type Env = Record<string, string | undefined>;

export type WorkerConfig = {
  telegramApiId: number;
  telegramApiHash: string;
  telegramSession: string;
  workerToken: string;
  host: string;
  port: number;
  caPem: string;
  serverCertPem: string;
  serverKeyPem: string;
  revision: string;
};

type ReadTextFile = (path: string) => Promise<string>;

function required(env: Env, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function readPemFile(
  readText: ReadTextFile,
  env: Env,
  name: string,
): Promise<string> {
  const path = required(env, name);
  try {
    return await readText(path);
  } catch {
    throw new Error(`Missing or unreadable TLS file for ${name}: ${path}`);
  }
}

export async function loadWorkerConfig(
  env: Env = process.env,
  readText: ReadTextFile = (path) => readFile(path, "utf8"),
): Promise<WorkerConfig> {
  const telegram = loadTelegramConfig(env);

  const rawPort = required(env, "TELEGRAM_WORKER_PORT");
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("TELEGRAM_WORKER_PORT must be an integer from 1 to 65535");
  }

  const revision = env.GRAMSCOPE_REVISION?.trim();
  if (!revision) {
    throw new Error("Missing required environment variable: GRAMSCOPE_REVISION");
  }

  return {
    ...telegram,
    workerToken: required(env, "TELEGRAM_WORKER_TOKEN"),
    host: env.TELEGRAM_WORKER_HOST?.trim() || "0.0.0.0",
    port,
    caPem: await readPemFile(readText, env, "TELEGRAM_WORKER_CA_FILE"),
    serverCertPem: await readPemFile(
      readText,
      env,
      "TELEGRAM_WORKER_SERVER_CERT_FILE",
    ),
    serverKeyPem: await readPemFile(
      readText,
      env,
      "TELEGRAM_WORKER_SERVER_KEY_FILE",
    ),
    revision,
  };
}
