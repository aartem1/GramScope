import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { markUnread } from "../../telegram/read-state";
import { MAX_MARK_READ_SOURCES } from "../../limits";
import { runTool } from "../tool-result";

export function registerMarkUnread(server: McpServer): void {
  server.registerTool(
    "mark_unread",
    {
      title: "Flag Telegram sources to come back to",
      description:
        "Set or clear Telegram's manual come-back-to-this flag on up to " +
        `${MAX_MARK_READ_SOURCES} sources. This CHANGES ACCOUNT STATE. The flag is separate from the unread count: setting it does not make already-read messages readable again, and clearing it marks nothing read. Flagged sources appear in get_unread_summary and in list_dialogs with unread_mark true, even at a count of zero. A source that cannot be reached is reported in failures and does not fail the call.`,
      inputSchema: z.object({
        source_ids: z.array(z.string()).min(1).max(MAX_MARK_READ_SOURCES),
        unread: z
          .boolean()
          .default(true)
          .describe("true sets the flag; false clears it."),
      }),
      outputSchema: z.object({
        results: z.array(
          z.object({
            source_id: z.string(),
            unread_mark: z.boolean(),
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
    async (input) => runTool("mark_unread", () => markUnread(input)),
  );
}
