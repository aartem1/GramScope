import {
  metadataCorsOptionsRequestHandler,
  protectedResourceHandler,
} from "mcp-handler";

const issuer = process.env.WORKOS_ISSUER;
if (!issuer) throw new Error("Missing required environment variable: WORKOS_ISSUER");

export const GET = protectedResourceHandler({ authServerUrls: [issuer] });
export const OPTIONS = metadataCorsOptionsRequestHandler();
