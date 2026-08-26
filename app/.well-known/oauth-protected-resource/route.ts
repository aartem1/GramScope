import {
  metadataCorsOptionsRequestHandler,
  protectedResourceHandler,
} from "mcp-handler";

/**
 * Serves RFC 9728 protected-resource metadata.
 *
 * Both values are read per request, not at module scope: Next imports every
 * route module during "Collecting page data", so a top-level throw would fail
 * the whole build wherever env vars arrive at runtime. This also matches how
 * loadConfig and verifyOwnerToken read their env.
 *
 * MCP_RESOURCE_URL is pinned as the resource identifier rather than letting
 * mcp-handler derive it from the request. Two reasons, both load-bearing:
 *
 *  - It must be the SAME string we validate the token's `aud` against, and the
 *    same one registered as a Resource Indicator in WorkOS. Advertising the
 *    origin while validating origin + /api/mcp means the client fetches a
 *    token for what we advertised and we reject it — a permanent 401.
 *  - Derivation trusts X-Forwarded-Host, which the caller controls, so the
 *    document would otherwise echo an attacker-supplied host.
 */
export function GET(req: Request): Response {
  const issuer = process.env.WORKOS_ISSUER;
  const resourceUrl = process.env.MCP_RESOURCE_URL;
  if (!issuer || !resourceUrl) {
    return Response.json({ error: "server_misconfigured" }, { status: 500 });
  }
  return protectedResourceHandler({
    authServerUrls: [issuer],
    resourceUrl,
  })(req);
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
