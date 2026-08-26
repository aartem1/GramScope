import { describe, expect, it } from "vitest";

const RESOURCE = "https://gramscope.example.app/api/mcp";

/**
 * The protected-resource document, the audience we verify, and the Resource
 * Indicator registered in WorkOS must all be the SAME string. If the document
 * advertises one identifier and we validate another, the client obtains a
 * token for what we advertised and we reject it — a permanent 401 that is
 * near-impossible to diagnose from the client side.
 */
describe("resource identifier", () => {
  it("advertises exactly the audience tokens are verified against", async () => {
    process.env.WORKOS_ISSUER = "https://auth.example.com";
    process.env.MCP_RESOURCE_URL = RESOURCE;

    const { GET } = await import(
      "../app/.well-known/oauth-protected-resource/route"
    );
    const res = GET(
      new Request(
        "https://gramscope.example.app/.well-known/oauth-protected-resource",
      ),
    );
    const body = (await res.json()) as { resource: string };

    expect(body.resource).toBe(RESOURCE);
  });

  it("ignores a forged host rather than advertising it", async () => {
    process.env.WORKOS_ISSUER = "https://auth.example.com";
    process.env.MCP_RESOURCE_URL = RESOURCE;

    const { GET } = await import(
      "../app/.well-known/oauth-protected-resource/route"
    );
    const res = GET(
      new Request("https://attacker.example.com/.well-known/oauth-protected-resource", {
        headers: { "x-forwarded-host": "attacker.example.com" },
      }),
    );
    const body = (await res.json()) as { resource: string };

    expect(body.resource).toBe(RESOURCE);
    expect(JSON.stringify(body)).not.toContain("attacker.example.com");
  });
});
