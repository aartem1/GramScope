import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type JWK,
  type KeyLike,
} from "jose";
import {
  verifyOwnerToken,
  __setKeyResolverForTests,
} from "@/mcp/auth";

const ISSUER = "https://auth.example.com";
const AUDIENCE = "https://gramscope.example.app";

// jose's installed types (5.10.0) resolve generateKeyPair's unannotated
// return to `KeyLike` (`{ type: string }`), not `CryptoKey` as the brief's
// draft declared — CryptoKey has required members KeyLike doesn't carry, so
// `let privateKey: CryptoKey` fails `tsc --noEmit` on assignment from
// `pair.privateKey`. KeyLike is the type SignJWT#sign actually accepts.
let privateKey: KeyLike;
let publicJwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  publicJwk = await exportJWK(pair.publicKey);
  publicJwk.alg = "RS256";
  publicJwk.kid = "test-key";
});

function env() {
  return {
    TELEGRAM_API_ID: "1",
    TELEGRAM_API_HASH: "h",
    TELEGRAM_SESSION: "s",
    WORKOS_ISSUER: ISSUER,
    WORKOS_JWKS_URL: `${ISSUER}/jwks`,
    OWNER_USER_ID: "user_owner",
    MCP_RESOURCE_URL: AUDIENCE,
  };
}

async function token(
  sub: string,
  overrides: { iss?: string; aud?: string | null } = {},
) {
  const jwt = new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(overrides.iss ?? ISSUER)
    .setSubject(sub)
    .setExpirationTime("5m");
  // null means "mint it with no aud claim at all" — the shape that used to be
  // accepted whenever MCP_RESOURCE_URL happened to be unset.
  if (overrides.aud !== null) jwt.setAudience(overrides.aud ?? AUDIENCE);
  return jwt.sign(privateKey);
}

beforeAll(() => {
  process.env = { ...process.env, ...env() };
});

afterEach(() => {
  __setKeyResolverForTests(undefined);
});

async function withLocalKeys() {
  const { createLocalJWKSet } = await import("jose");
  __setKeyResolverForTests(createLocalJWKSet({ keys: [publicJwk] }));
}

const request = new Request("https://gramscope.example.app/api/mcp");

describe("verifyOwnerToken", () => {
  it("returns undefined when no token is presented", async () => {
    await withLocalKeys();
    expect(await verifyOwnerToken(request, undefined)).toBeUndefined();
  });

  it("accepts the configured owner", async () => {
    await withLocalKeys();
    const info = await verifyOwnerToken(request, await token("user_owner"));
    expect(info?.extra.sub).toBe("user_owner");
  });

  it("rejects an authenticated non-owner with OWNER_FORBIDDEN", async () => {
    await withLocalKeys();
    await expect(
      verifyOwnerToken(request, await token("user_stranger")),
    ).rejects.toThrow(/OWNER_FORBIDDEN/);
  });

  it("rejects a token from the wrong issuer", async () => {
    await withLocalKeys();
    await expect(
      verifyOwnerToken(
        request,
        await token("user_owner", { iss: "https://evil.example.com" }),
      ),
    ).rejects.toBeTruthy();
  });

  it("rejects a token minted for another application's audience", async () => {
    // The owner may authorize several apps in one WorkOS environment. Without
    // this check any of them reaches full Telegram read access.
    await withLocalKeys();
    await expect(
      verifyOwnerToken(
        request,
        await token("user_owner", { aud: "https://other.example.app" }),
      ),
    ).rejects.toThrow(/aud/);
  });

  it("rejects a token that carries no audience claim", async () => {
    await withLocalKeys();
    await expect(
      verifyOwnerToken(request, await token("user_owner", { aud: null })),
    ).rejects.toThrow(/aud/);
  });

  it("rejects a garbage token", async () => {
    await withLocalKeys();
    await expect(verifyOwnerToken(request, "not.a.jwt")).rejects.toBeTruthy();
  });
});
