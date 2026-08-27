import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { registerTools } from "@/mcp/server";
import { verifyOwnerToken } from "@/mcp/auth";
import { logEvent } from "@/mcp/logging";
import { MCP_SERVER_VERSION } from "@/mcp/version";

/**
 * Spec §7: a 25-source fan-out at 8-way concurrency is four sequential rounds
 * of MTProto round trips. Vercel's 10-15s default would cut a wide digest off
 * mid-flight and report it as a server error.
 */
export const maxDuration = 60;

const handler = createMcpHandler(
  (server) => {
    registerTools(server);
  },
  {
    serverInfo: { name: "gramscope", version: MCP_SERVER_VERSION },
    onEvent: (event) => logEvent(event),
  },
);

/**
 * Pins the origin the 401 challenge advertises, instead of letting
 * mcp-handler derive it from the X-Forwarded-Host header a client controls.
 *
 * mcp-handler concatenates `${origin}${resourceMetadataPath}`, so it wants the
 * ORIGIN — MCP_RESOURCE_URL is the full resource identifier (origin +
 * /api/mcp), hence the URL parse. Read defensively rather than through
 * loadConfig: Next imports every route module during "Collecting page data",
 * where runtime-only env vars are absent, and a module-scope throw would fail
 * the build.
 */
function resourceOrigin(): string | undefined {
  const raw = process.env.MCP_RESOURCE_URL;
  if (!raw) return undefined;
  try {
    return new URL(raw).origin;
  } catch {
    return undefined;
  }
}

const origin = resourceOrigin();

const authed = withMcpAuth(handler, verifyOwnerToken, {
  required: true,
  resourceMetadataPath: "/.well-known/oauth-protected-resource",
  ...(origin ? { resourceUrl: origin } : {}),
});

export { authed as GET, authed as POST };
