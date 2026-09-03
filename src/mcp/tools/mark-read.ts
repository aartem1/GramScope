import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { markRead } from "../../telegram/read-state";
import { MAX_MARK_READ_SOURCES } from "../../limits";
import { runTool } from "../tool-result";

export function registerMarkRead(server: McpServer): void {
  server.registerTool(
    "mark_read",
    {
      title: "Mark Telegram sources as read",
      description:
        "Advance the read pointer on up to " +
        `${MAX_MARK_READ_SOURCES} sources, so the next unread sweep does not return the same messages. This CHANGES ACCOUNT STATE and is visible in every Telegram client on the account; reading never does. Without up_to_message_id each source is marked read through its latest message. A source that cannot be reached is reported in failures and does not fail the call.`,
      inputSchema: z.object({
        source_ids: z.array(z.string()).min(1).max(MAX_MARK_READ_SOURCES),
        up_to_message_id: z
          .number()
          .int()
          .optional()
          .describe(
            "Mark read through this message id. Omit to use each source's latest message.",
          ),
      }),
      outputSchema: z.object({
        results: z.array(
          z.object({
            source_id: z.string(),
            read_inbox_max_id: z.number().int(),
          }),
        ),
        failures: z.array(
          z.object({
            source_id: z.string(),
            code: z.string(),
            message: z.string(),
          }),
        ),
      }),
      annotations: { readOnlyHint: false },
    },
    async (input) => runTool("mark_read", () => markRead(input)),
  );
}
