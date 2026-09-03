import { describe, expect, it } from "vitest";
import {
  isRemoteDispatchEnabled,
  loadConfig,
  loadTelegramConfig,
  loadWorkerClientConfig,
} from "@/config";

const telegramOnly = {
  TELEGRAM_API_ID: "12345",
  TELEGRAM_API_HASH: "abc",
  TELEGRAM_SESSION: "sess",
};

const complete = {
  ...telegramOnly,
  WORKOS_ISSUER: "https://auth.example.com",
  WORKOS_JWKS_URL: "https://auth.example.com/jwks",
  OWNER_USER_ID: "user_123",
  MCP_RESOURCE_URL: "https://gramscope.example.app/api/mcp",
  MEDIA_TOKEN_SECRET: Buffer.alloc(32, 7).toString("base64url"),
};

const samplePem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";

const remoteComplete = {
  WORKOS_ISSUER: complete.WORKOS_ISSUER,
  WORKOS_JWKS_URL: complete.WORKOS_JWKS_URL,
  OWNER_USER_ID: complete.OWNER_USER_ID,
  MCP_RESOURCE_URL: complete.MCP_RESOURCE_URL,
  MEDIA_TOKEN_SECRET: complete.MEDIA_TOKEN_SECRET,
  TELEGRAM_WORKER_URL: "https://127.0.0.1:8443",
  TELEGRAM_WORKER_TOKEN: "worker-token",
  TELEGRAM_WORKER_CA: Buffer.from(samplePem, "utf8").toString("base64"),
  TELEGRAM_WORKER_CLIENT_CERT: Buffer.from(samplePem, "utf8").toString("base64"),
  TELEGRAM_WORKER_CLIENT_KEY: Buffer.from(
    "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n",
    "utf8",
  ).toString("base64"),
};

describe("loadTelegramConfig", () => {
  it("parses Telegram credentials without WorkOS or media variables", () => {
    const config = loadTelegramConfig(telegramOnly);
    expect(config.telegramApiId).toBe(12345);
    expect(config.telegramApiHash).toBe("abc");
    expect(config.telegramSession).toBe("sess");
  });

  it("names the missing Telegram variable", () => {
    expect(() =>
      loadTelegramConfig({ ...telegramOnly, TELEGRAM_SESSION: undefined }),
    ).toThrow(/TELEGRAM_SESSION/);
  });
});

describe("loadConfig", () => {
  it("parses a complete environment", () => {
    const config = loadConfig(complete);
    expect(config.telegram?.telegramApiId).toBe(12345);
    expect(config.ownerUserId).toBe("user_123");
    expect(config.worker).toBeUndefined();
  });

  it("loads worker client config without Telegram credentials when remote dispatch is enabled", () => {
    const config = loadConfig(remoteComplete);
    expect(config.telegram).toBeUndefined();
    expect(config.worker?.workerUrl).toBe("https://127.0.0.1:8443");
    expect(config.worker?.caPem).toContain("BEGIN CERTIFICATE");
  });

  it("requires worker TLS variables when TELEGRAM_WORKER_URL is set", () => {
    expect(() =>
      loadConfig({ ...remoteComplete, TELEGRAM_WORKER_CA: undefined }),
    ).toThrow(/TELEGRAM_WORKER_CA/);
  });
});

describe("remote dispatch config helpers", () => {
  it("detects remote dispatch from TELEGRAM_WORKER_URL", () => {
    expect(isRemoteDispatchEnabled({ TELEGRAM_WORKER_URL: "https://x" })).toBe(
      true,
    );
    expect(isRemoteDispatchEnabled({})).toBe(false);
  });

  it("decodes base64 PEM worker client material", () => {
    const worker = loadWorkerClientConfig(remoteComplete);
    expect(worker.workerToken).toBe("worker-token");
    expect(worker.clientKeyPem).toContain("BEGIN PRIVATE KEY");
  });
});

describe("loadConfig validation", () => {

  it("still requires Vercel-only variables on top of Telegram config", () => {
    expect(() => loadConfig(telegramOnly)).toThrow(/WORKOS_ISSUER|MCP_RESOURCE_URL/);
  });

  it("names the missing variable", () => {
    expect(() =>
      loadConfig({ ...complete, OWNER_USER_ID: undefined }),
    ).toThrow(/OWNER_USER_ID/);
  });

  it("requires MCP_RESOURCE_URL, the audience every token is checked against", () => {
    expect(() =>
      loadConfig({ ...complete, MCP_RESOURCE_URL: undefined }),
    ).toThrow(/MCP_RESOURCE_URL/);
  });

  it("exposes the resource url to the audience check", () => {
    expect(loadConfig(complete).mcpResourceUrl).toBe(
      "https://gramscope.example.app/api/mcp",
    );
  });

  it("rejects a non-numeric api id", () => {
    expect(() =>
      loadConfig({ ...complete, TELEGRAM_API_ID: "nope" }),
    ).toThrow(/TELEGRAM_API_ID/);
  });

  it("requires the media token secret", () => {
    expect(() =>
      loadConfig({ ...complete, MEDIA_TOKEN_SECRET: undefined }),
    ).toThrow(/MEDIA_TOKEN_SECRET/);
  });

  it("rejects a malformed media token secret without echoing it", () => {
    const secret = "not+base64/url=";
    try {
      loadConfig({ ...complete, MEDIA_TOKEN_SECRET: secret });
      throw new Error("expected loadConfig to reject the secret");
    } catch (error) {
      expect(String(error)).toContain("MEDIA_TOKEN_SECRET");
      expect(String(error)).not.toContain(secret);
    }
  });

  it("rejects a media token secret that is not 32 bytes without echoing it", () => {
    const secret = Buffer.alloc(31, 9).toString("base64url");
    try {
      loadConfig({ ...complete, MEDIA_TOKEN_SECRET: secret });
      throw new Error("expected loadConfig to reject the secret");
    } catch (error) {
      expect(String(error)).toContain("exactly 32 bytes");
      expect(String(error)).not.toContain(secret);
    }
  });
});
