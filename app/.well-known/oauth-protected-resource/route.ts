import {
  metadataCorsOptionsRequestHandler,
  protectedResourceHandler,
} from "mcp-handler";

// Read the issuer per request, not at module scope. Next imports every route
// module during "Collecting page data", so a top-level throw fails the whole
// build wherever env vars are injected at runtime rather than build time —
// fork preview builds, local builds, and secret-at-runtime pipelines. This
// also matches how loadConfig and verifyOwnerToken read their env.
export function GET(req: Request): Response {
  const issuer = process.env.WORKOS_ISSUER;
  if (!issuer) {
    return Response.json(
      { error: "server_misconfigured" },
      { status: 500 },
    );
  }
  return protectedResourceHandler({ authServerUrls: [issuer] })(req);
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
