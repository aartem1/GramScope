export const DEFAULT_WORKER_ENV_PATH = "/etc/gramscope/worker.env";

/** Default env file loaded by `npm run telegram:login:worker`. */
export const WORKER_LOGIN_ENV_FILE = DEFAULT_WORKER_ENV_PATH;

export function parseWorkerLoginTarget(argv: string[]): "worker" {
  const at = argv.indexOf("--target");
  if (at === -1) {
    throw new Error(
      "Pass --target worker. This login writes TELEGRAM_SESSION only to the worker environment file.",
    );
  }
  const value = argv[at + 1];
  if (value !== "worker") {
    throw new Error(
      `Unknown --target ${value ?? "(missing)"}; expected worker`,
    );
  }
  return "worker";
}

export function resolveWorkerEnvPath(argv: string[]): string {
  const at = argv.indexOf("--write-env");
  if (at === -1) return DEFAULT_WORKER_ENV_PATH;
  const path = argv[at + 1];
  if (!path) {
    throw new Error("--write-env requires a file path");
  }
  return path;
}

export function createPasswordPrompt(
  provided: string | undefined,
  ask: () => Promise<string>,
): () => Promise<string> {
  return async () => (provided !== undefined ? provided : ask());
}
