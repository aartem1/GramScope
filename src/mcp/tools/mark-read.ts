import type { McpServer } from "@modelcontextprotocol/server";
import { MAX_MARK_READ_SOURCES } from "../../limits";
import {
  markRead,
  markReadInputSchema,
  markReadOutputSchema,
} from "../../ops";
import { runTool } from "../tool-result";

export function registerMarkRead(server: McpServer): void {
  server.registerTool(
    "mark_read",
    {
      title: "Mark Telegram sources as read",
      description:
        "Advance the read pointer on up to " +
        `${MAX_MARK_READ_SOURCES} sources, so the next unread sweep does not return the same messages. This CHANGES ACCOUNT STATE and is visible in every Telegram client on the account; reading never does. Without up_to_message_id each source is marked read through its latest message. A source that cannot be reached is reported in failures and does not fail the call.`,
      inputSchema: markReadInputSchema,
      outputSchema: markReadOutputSchema,
      annotations: { readOnlyHint: false },
    },
    async (input) => runTool("mark_read", () => markRead(input)),
  );
}
