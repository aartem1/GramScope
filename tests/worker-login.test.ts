import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createPasswordPrompt,
  DEFAULT_WORKER_ENV_PATH,
  parseWorkerLoginTarget,
  resolveWorkerEnvPath,
  WORKER_LOGIN_ENV_FILE,
} from "../scripts/worker-login-args";

describe("worker login args", () => {
  it("requires --target worker", () => {
    expect(parseWorkerLoginTarget(["--target", "worker"])).toBe("worker");
    expect(() => parseWorkerLoginTarget([])).toThrow(/--target worker/);
    expect(() => parseWorkerLoginTarget(["--target", "local"])).toThrow(
      /expected worker/,
    );
  });

  it("defaults the env path to the systemd location", () => {
    expect(resolveWorkerEnvPath([])).toBe(DEFAULT_WORKER_ENV_PATH);
    expect(resolveWorkerEnvPath(["--write-env", "/tmp/worker.env"])).toBe(
      "/tmp/worker.env",
    );
    expect(() => resolveWorkerEnvPath(["--write-env"])).toThrow(
      /--write-env requires a file path/,
    );
  });

  it("pins the npm script to load credentials from the worker env file", () => {
    const packageJson = JSON.parse(
      readFileSync(join(import.meta.dirname, "../package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts["telegram:login:worker"]).toBe(
      `node --env-file=${WORKER_LOGIN_ENV_FILE} dist/worker/scripts/create-telegram-session.js --target worker`,
    );
    expect(packageJson.scripts["telegram:login:worker"]).not.toMatch(
      /TELEGRAM_(API_ID|API_HASH|SESSION)/,
    );
  });

  it("prompts for 2FA only when no password was supplied", async () => {
    const ask = async () => "asked";
    await expect(createPasswordPrompt("provided", ask)()).resolves.toBe(
      "provided",
    );
    await expect(createPasswordPrompt(undefined, ask)()).resolves.toBe("asked");
  });
});
