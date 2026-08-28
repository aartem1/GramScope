import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { getPinnedMessages } from "../../telegram/pinned";
import { telegramMessageSchema } from "../../schemas/message";
import { runTool } from "../tool-result";

export function registerGetPinnedMessages(server: McpServer): void {
  server.registerTool(
    "get_pinned_messages",
    {
      title: "Read a source's pinned messages",
      description:
        "Read the pinned messages of one Telegram source, newest first. Pinned posts are usually a channel's rules, its navigation, or the announcement it wants read first, so this is the cheapest way to learn what a source is about. The source may be named by marked id, @username, or t.me link, including a public channel the account has not joined. A source with nothing pinned returns an empty list, not an error. Read-only.",
      inputSchema: z.object({
        source_id: z
          .string()
          .describe("A marked id, a @username, or a t.me link."),
        limit: z.number().int().min(1).max(100).default(20),
        cursor: z
          .string()
          .describe(
            "Opaque continuation token from a previous response's next_cursor. Copy it back exactly as received, character for character; it is not human-readable and must not be shortened, re-typed or reconstructed. It is bound to this source_id.",
          )
          .optional(),
      }),
      outputSchema: z.object({
        source_id: z.string(),
        source_title: z.string(),
        messages: z.array(telegramMessageSchema),
        next_cursor: z.string().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      runTool("get_pinned_messages", () => getPinnedMessages(input)),
  );
}
