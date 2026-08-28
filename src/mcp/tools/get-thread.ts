import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { getThread } from "../../telegram/thread";
import { telegramMessageSchema } from "../../schemas/message";
import { runTool } from "../tool-result";

export function registerGetThread(server: McpServer): void {
  server.registerTool(
    "get_thread",
    {
      title: "Read the comments under a Telegram post",
      description:
        "Read the discussion thread under one channel post: the post itself plus the comments left on it, newest first. Works without joining the channel's linked discussion group. Before calling, check the post's replies field, which every message-returning tool already reports: it is the comment count, and a post that has no replies field belongs to a channel with no discussion group at all (NO_DISCUSSION_THREAD). A post with zero comments returns an empty comments list, not an error. comment_count is the discussion group's own live count and can run slightly ahead of the post's replies field. discussion_chat_id identifies the linked group but is NOT an address: get_messages cannot read it, because the account is not a member. Read-only.",
      inputSchema: z.object({
        source_id: z
          .string()
          .describe(
            "The CHANNEL the post is in — a marked id, a @username, or a t.me link. Not the discussion group.",
          ),
        post_id: z
          .number()
          .int()
          .describe("Message id of the post inside that channel."),
        limit: z.number().int().min(1).max(100).default(20),
        cursor: z
          .string()
          .describe(
            "Opaque continuation token from a previous response's next_cursor. Copy it back exactly as received, character for character; it is not human-readable and must not be shortened, re-typed or reconstructed. It is bound to this source_id and post_id.",
          )
          .optional(),
      }),
      outputSchema: z.object({
        source_id: z.string(),
        source_title: z.string(),
        post: telegramMessageSchema,
        discussion_chat_id: z.string().optional(),
        comment_count: z.number().int(),
        comments: z.array(telegramMessageSchema),
        next_cursor: z.string().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (input) => runTool("get_thread", () => getThread(input)),
  );
}
