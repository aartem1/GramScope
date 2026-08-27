import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { getUnreadSummary } from "../../telegram/unread";
import { runTool } from "../tool-result";

export function registerGetUnreadSummary(server: McpServer): void {
  server.registerTool(
    "get_unread_summary",
    {
      title: "Summarize unread Telegram messages",
      description:
        "Report how many unread messages each source, or each folder, is holding. Only sources or folders with unread messages are returned, busiest first. The oldest unread message's date is not reported; get_messages with unread_only and limit 1 answers that for one source. Read-only.",
      inputSchema: z.object({
        group_by: z.enum(["source", "folder"]).default("source"),
        folder_ids: z
          .array(z.string())
          .optional()
          .describe("Narrow the report to these folders."),
      }),
      outputSchema: z.object({
        groups: z.array(
          z.object({
            source_id: z.string().optional(),
            folder_id: z.string().optional(),
            title: z.string(),
            unread_count: z.number().int(),
            read_inbox_max_id: z.number().int().optional(),
            latest_message_id: z.number().int().optional(),
            latest_message_date: z.string().optional(),
          }),
        ),
        total_unread: z.number().int(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      runTool("get_unread_summary", () => getUnreadSummary(input)),
  );
}
