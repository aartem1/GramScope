import type { McpServer } from "@modelcontextprotocol/server";
import {
  getUnreadSummary,
  getUnreadSummaryInputSchema,
  getUnreadSummaryOutputSchema,
} from "../../ops";
import { runTool } from "../tool-result";

export function registerGetUnreadSummary(server: McpServer): void {
  server.registerTool(
    "get_unread_summary",
    {
      title: "Summarize unread Telegram messages",
      description:
        "Report how many unread messages each source, or each folder, is holding. Sources are returned busiest first; a source flagged with mark_unread is also returned, with unread_mark true and a count that may be zero. Folder grouping counts messages only and ignores the flag. The oldest unread message's date is not reported; get_messages with unread_only and limit 1 answers that for one source. Read-only.",
      inputSchema: getUnreadSummaryInputSchema,
      outputSchema: getUnreadSummaryOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      runTool("get_unread_summary", () => getUnreadSummary(input)),
  );
}
