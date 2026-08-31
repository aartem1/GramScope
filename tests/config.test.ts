import { describe, expect, it } from "vitest";
import { loadConfig } from "@/config";

const complete = {
  TELEGRAM_API_ID: "12345",
  TELEGRAM_API_HASH: "abc",
  TELEGRAM_SESSION: "sess",
  WORKOS_ISSUER: "https://auth.example.com",
  WORKOS_JWKS_URL: "https://auth.example.com/jwks",
  OWNER_USER_ID: "user_123",
  MCP_RESOURCE_URL: "https://gramscope.example.app/api/mcp",
  MEDIA_TOKEN_SECRET: Buffer.alloc(32, 7).toString("base64url"),
};

describe("loadConfig", () => {
  it("parses a complete environment", () => {
    const config = loadConfig(complete);
    expect(config.telegramApiId).toBe(12345);
    expect(config.ownerUserId).toBe("user_123");
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
