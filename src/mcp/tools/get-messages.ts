import type { McpServer } from "@modelcontextprotocol/server";
import { MAX_SOURCES_PER_CALL } from "../../limits";
import {
  getMessages,
  getMessagesInputSchema,
  getMessagesOutputSchema,
} from "../../ops";
import { runTool } from "../tool-result";

export function registerGetMessages(server: McpServer): void {
  server.registerTool(
    "get_messages",
    {
      title: "Read Telegram message history",
      description:
        "Read recent messages from one or many Telegram sources in a single call. Sources are named by source_ids, by folder_ids (expanded to their member channels), or both, minus exclude_source_ids; the effective set is capped at " +
        `${MAX_SOURCES_PER_CALL} sources. Results are grouped by source, newest first within each source, and limit applies PER SOURCE. Date filtering with from/to is independent of read state, so a date-windowed read returns messages whether or not they have been read. A source that was reached but matched nothing has an empty messages array; a source this page never reached is absent from the response and named in next_cursor. To continue, resend every filter unchanged together with next_cursor — the cursor supplies its own source set, so source_ids, folder_ids and exclude_source_ids are ignored when it is present. Read-only: this does not mark anything as read.`,
      inputSchema: getMessagesInputSchema,
      outputSchema: getMessagesOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => runTool("get_messages", () => getMessages(input)),
  );
}
