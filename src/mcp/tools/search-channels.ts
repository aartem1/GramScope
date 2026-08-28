import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  MAX_ENRICHED_CANDIDATES,
  searchChannels,
} from "../../telegram/discovery";
import { searchChannelsResultSchema } from "../../schemas/discovery";
import { runTool } from "../tool-result";

export function registerSearchChannels(server: McpServer): void {
  server.registerTool(
    "search_channels",
    {
      title: "Find public Telegram channels",
      description:
        'Find public Telegram channels by name. This searches titles and @usernames, not by topic: "AI" finds nothing while "artificial intelligence" finds channels whose name contains it. An empty result usually means the query was too short or abbreviated, NOT that no such channels exist — retry with the full name, or call get_similar_channels from a channel you already know, which is the better tool for "find me more like this". Telegram caps this at 10 candidates and offers no pagination or cursor; truncated says whether it capped. Order is Telegram\'s own and is never re-ranked, with channels this account already follows first. Each candidate carries verified, scam, fake and restricted so you can judge it before recommending it, and joined says whether the account already follows it. Inspect a candidate with get_pinned_messages or get_messages before trusting it. This tool joins nothing and changes nothing. Read-only.',
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe(
            "Words from the channel's name or its @username. Not a topic: use the fullest name you know.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_ENRICHED_CANDIDATES)
          .optional()
          .describe("How many candidates to return. 1-10, default 10."),
      }),
      outputSchema: searchChannelsResultSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => runTool("search_channels", () => searchChannels(input)),
  );
}
