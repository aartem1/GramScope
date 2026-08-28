import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { getSimilarChannels } from "../../telegram/discovery";
import { similarChannelsResultSchema } from "../../schemas/discovery";
import { runTool } from "../tool-result";
import { OUTSIDE_SOURCE_GUIDANCE } from "../source-guidance";

export function registerGetSimilarChannels(server: McpServer): void {
  server.registerTool(
    "get_similar_channels",
    {
      title: "Telegram's own channel recommendations",
      description: `Telegram's own recommendations. With source, it returns channels similar to that one. Without source, it returns channels recommended for this whole account from everything it already follows — that is the tool for "what else should I be reading". total_similar is how many similar channels Telegram knows about; only about 10 are served and the rest need Telegram Premium, so no argument reaches them and truncated says so. Order is Telegram's own and is never re-ranked: read candidates with get_messages or get_pinned_messages and pick the best yourself. Each candidate carries verified, scam, fake and restricted, and joined says whether the account already follows it. ${OUTSIDE_SOURCE_GUIDANCE} This tool joins nothing and changes nothing. Read-only.`,
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
          .max(10)
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
