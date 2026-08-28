import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  getSimilarChannels,
  MAX_ENRICHED_CANDIDATES,
} from "../../telegram/discovery";
import { similarChannelsResultSchema } from "../../schemas/discovery";
import { runTool } from "../tool-result";

export function registerGetSimilarChannels(server: McpServer): void {
  server.registerTool(
    "get_similar_channels",
    {
      title: "Telegram's own channel recommendations",
      description:
        "Telegram's own recommendations. With source supplied, total_similar is the number Telegram knows; only about 10 are served, the remainder requires Telegram Premium, and no argument reaches it. With source omitted, Telegram may offer about 100 ordinary account recommendations; GramScope safely returns only the first limit (maximum 10); there is no pagination or cursor; repeating the same call does not reach the remainder. Order is Telegram's own and is never re-ranked: read candidates with get_messages or get_pinned_messages and pick the best yourself. Each candidate carries verified, scam, fake and restricted, and joined says whether the account already follows it. This tool joins nothing and changes nothing. Read-only.",
      inputSchema: z.object({
        source: z
          .string()
          .optional()
          .describe(
            "The channel to find neighbours of — marked id, @username, or t.me link. Omit it to get recommendations for the whole account.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_ENRICHED_CANDIDATES)
          .optional()
          .describe("How many candidates to return. 1-10, default 10."),
      }),
      outputSchema: similarChannelsResultSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      runTool("get_similar_channels", () => getSimilarChannels(input)),
  );
}
