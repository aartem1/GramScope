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

export async function verifyOwnerToken(
  _req: Request,
  bearerToken?: string,
): Promise<VerifiedOwner | undefined> {
  if (!bearerToken) return undefined;

  const config = loadConfig();

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
