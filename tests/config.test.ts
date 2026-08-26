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
});
