import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { registerTools } from "@/mcp/server";
import { verifyOwnerToken } from "@/mcp/auth";
import { logEvent } from "@/mcp/logging";

const handler = createMcpHandler(
  (server) => {
    registerTools(server);
  },
  {
    serverInfo: { name: "gramscope", version: "0.1.0" },
    onEvent: (event) => logEvent(event),
  },
);

const authed = withMcpAuth(handler, verifyOwnerToken, {
  required: true,
  resourceMetadataPath: "/.well-known/oauth-protected-resource",
});

export { authed as GET, authed as POST };
