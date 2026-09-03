import type { McpServer } from "@modelcontextprotocol/server";
import {
  getThread,
  getThreadInputSchema,
  getThreadOutputSchema,
} from "../../ops";
import { runTool } from "../tool-result";

export function registerGetThread(server: McpServer): void {
  server.registerTool(
    "get_thread",
    {
      title: "Read the comments under a Telegram post",
      description:
        "Read the discussion thread under one channel post: the post itself plus the comments left on it, newest first. Works without joining the channel's linked discussion group. Before calling, check the post's replies field, which every message-returning tool already reports: it is the comment count, and a post that has no replies field belongs to a channel with no discussion group at all (NO_DISCUSSION_THREAD). A post with zero comments returns an empty comments list, not an error. comment_count is the discussion group's own live count and can run slightly ahead of the post's replies field. discussion_chat_id identifies the linked group but is NOT an address: get_messages cannot read it, because the account is not a member. Read-only.",
      inputSchema: getThreadInputSchema,
      outputSchema: getThreadOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => runTool("get_thread", () => getThread(input)),
  );
}
