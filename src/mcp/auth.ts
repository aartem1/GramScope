import { timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { loadConfig } from "../config";
import { GramScopeError } from "../errors/taxonomy";

export type VerifiedOwner = {
  token: string;
  clientId: string;
  scopes: string[];
  extra: { sub: string };
};

type KeyResolver = Parameters<typeof jwtVerify>[1];

let testResolver: KeyResolver | undefined;
let remoteResolver: KeyResolver | undefined;

export function __setKeyResolverForTests(
  resolver: KeyResolver | undefined,
): void {
  testResolver = resolver;
}

function resolver(jwksUrl: string): KeyResolver {
  if (testResolver) return testResolver;
  remoteResolver ??= createRemoteJWKSet(new URL(jwksUrl));
  return remoteResolver;
}

function ownerApiTokenMatches(
  configured: string,
  presented: string,
): boolean {
  const a = Buffer.from(configured, "utf8");
  const b = Buffer.from(presented, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function verifyOwnerToken(
  _req: Request,
  bearerToken?: string,
): Promise<VerifiedOwner | undefined> {
  if (!bearerToken) return undefined;

  const config = loadConfig();

  // Optional static owner token (GRAMSCOPE_OWNER_API_TOKEN): a non-OAuth
  // path for clients that cannot complete the OAuth flow. This service has
  // exactly one owner, so a constant-time match is the owner — the same
  // identity the JWT path returns below. Unset means the path does not
  // exist; a non-match falls through to JWT verification unchanged.
  if (
    config.ownerApiToken &&
    ownerApiTokenMatches(config.ownerApiToken, bearerToken)
  ) {
    return {
      token: bearerToken,
      clientId: "owner-api-token",
      scopes: [],
      extra: { sub: config.ownerUserId },
    };
  }

  // Audience is checked unconditionally. Skipping it when unconfigured meant
  // a token minted for any other application in the same WorkOS environment —
  // or a token with no `aud` at all — reached full Telegram read access.
  const { payload } = await jwtVerify(
    bearerToken,
    resolver(config.workosJwksUrl),
    {
      issuer: config.workosIssuer,
      audience: config.mcpResourceUrl,
    },
  );

  const sub = payload.sub;
  if (typeof sub !== "string" || sub !== config.ownerUserId) {
    throw new GramScopeError(
      "OWNER_FORBIDDEN",
      "OWNER_FORBIDDEN: this MCP server serves a single configured owner",
    );
  }

  return {
    token: bearerToken,
    clientId: typeof payload.azp === "string" ? payload.azp : "unknown",
    scopes: [],
    extra: { sub },
  };
}
