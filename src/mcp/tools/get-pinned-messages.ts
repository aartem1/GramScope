import type { McpServer } from "@modelcontextprotocol/server";
import {
  getPinnedMessages,
  getPinnedMessagesInputSchema,
  getPinnedMessagesOutputSchema,
} from "../../ops";
import { runTool } from "../tool-result";

export function registerGetPinnedMessages(server: McpServer): void {
  server.registerTool(
    "get_pinned_messages",
    {
      title: "Read a source's pinned messages",
      description:
        "Read the pinned messages of one Telegram source, newest first. Pinned posts are usually a channel's rules, its navigation, or the announcement it wants read first, so this is the cheapest way to learn what a source is about. The source may be named by marked id, @username, or t.me link, including a public channel the account has not joined. A source with nothing pinned returns an empty list, not an error. Read-only.",
      inputSchema: getPinnedMessagesInputSchema,
      outputSchema: getPinnedMessagesOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      runTool("get_pinned_messages", () => getPinnedMessages(input)),
  );
}
