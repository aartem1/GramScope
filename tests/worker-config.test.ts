import { describe, expect, it } from "vitest";
import { loadWorkerConfig } from "../src/worker/config";

const complete = {
  TELEGRAM_API_ID: "12345",
  TELEGRAM_API_HASH: "abc",
  TELEGRAM_SESSION: "session-value",
  TELEGRAM_WORKER_TOKEN: "worker-token",
  TELEGRAM_WORKER_PORT: "8443",
  TELEGRAM_WORKER_CA_FILE: "/etc/gramscope/tls/ca.crt",
  TELEGRAM_WORKER_SERVER_CERT_FILE: "/etc/gramscope/tls/worker.crt",
  TELEGRAM_WORKER_SERVER_KEY_FILE: "/etc/gramscope/tls/worker.key",
  GRAMSCOPE_REVISION: "abc1234",
};

describe("loadWorkerConfig", () => {
  it("parses a complete worker environment and PEM files", async () => {
    const readText = async (path: string) => `PEM:${path}`;
    const config = await loadWorkerConfig(complete, readText);
    expect(config.telegramApiId).toBe(12345);
    expect(config.port).toBe(8443);
    expect(config.host).toBe("0.0.0.0");
    expect(config.revision).toBe("abc1234");
    expect(config.caPem).toContain("ca.crt");
  });

  it("names the missing variable without echoing secrets", async () => {
    await expect(
      loadWorkerConfig(
        { ...complete, TELEGRAM_WORKER_TOKEN: undefined },
        async () => "pem",
      ),
    ).rejects.toThrow(/TELEGRAM_WORKER_TOKEN/);

    try {
      await loadWorkerConfig(
        { ...complete, TELEGRAM_WORKER_TOKEN: undefined },
        async () => "pem",
      );
    } catch (error) {
      expect(String(error)).not.toContain("session-value");
    }
  });

  it("rejects a non-numeric worker port", async () => {
    await expect(
      loadWorkerConfig({ ...complete, TELEGRAM_WORKER_PORT: "nope" }, async () => "pem"),
    ).rejects.toThrow(/TELEGRAM_WORKER_PORT/);
  });

  it("requires GRAMSCOPE_REVISION", async () => {
    await expect(
      loadWorkerConfig({ ...complete, GRAMSCOPE_REVISION: undefined }, async () => "pem"),
    ).rejects.toThrow(/GRAMSCOPE_REVISION/);
  });

  it("names unreadable TLS files without echoing their contents", async () => {
    await expect(
      loadWorkerConfig(complete, async (path) => {
        if (path.includes("ca.crt")) throw new Error("ENOENT");
        return "pem";
      }),
    ).rejects.toThrow(/TELEGRAM_WORKER_CA_FILE/);
  });
});
