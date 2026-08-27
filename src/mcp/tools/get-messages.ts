import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { getMessages, MAX_SOURCES_PER_CALL } from "../../telegram/messages";
import { MEDIA_TYPES } from "../../telegram/message-slice";
import { telegramMessageSchema } from "../../schemas/message";
import { runTool } from "../tool-result";

export const sourceBlockSchema = z.object({
  source_id: z.string(),
  title: z.string(),
  messages: z.array(telegramMessageSchema).optional(),
  has_more: z.boolean().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});

export function registerGetMessages(server: McpServer): void {
  server.registerTool(
    "get_messages",
    {
      title: "Read Telegram message history",
      description:
        "Read recent messages from one or many Telegram sources in a single call. Sources are named by source_ids, by folder_ids (expanded to their member channels), or both, minus exclude_source_ids; the effective set is capped at " +
        `${MAX_SOURCES_PER_CALL} sources. Results are grouped by source, newest first within each source, and limit applies PER SOURCE. Date filtering with from/to is independent of read state, so a date-windowed read returns messages whether or not they have been read. A source that was reached but matched nothing has an empty messages array; a source this page never reached is absent from the response and named in next_cursor. To continue, resend every filter unchanged together with next_cursor — the cursor supplies its own source set, so source_ids, folder_ids and exclude_source_ids are ignored when it is present. Read-only: this does not mark anything as read.`,
      inputSchema: z.object({
        source_ids: z
          .array(z.string())
          .optional()
          .describe("Marked source ids as returned by list_dialogs."),
        folder_ids: z
          .array(z.string())
          .optional()
          .describe(
            "Folder ids from list_folders, expanded to their member sources.",
          ),
        exclude_source_ids: z
          .array(z.string())
          .optional()
          .describe("Subtracted from the union of source_ids and folder_ids."),
        from: z
          .string()
          .optional()
          .describe("ISO 8601. Inclusive lower bound on message date."),
        to: z
          .string()
          .optional()
          .describe("ISO 8601. Inclusive upper bound on message date."),
        unread_only: z
          .boolean()
          .optional()
          .describe("Return only messages above each source's read pointer."),
        media_type: z.enum(MEDIA_TYPES).optional(),
        limit: z.number().int().min(1).max(100).default(20),
        cursor: z
          .string()
          .describe(
            "Opaque continuation token from a previous response's next_cursor. Copy it back exactly as received, character for character; it is not human-readable and must not be shortened, re-typed or reconstructed.",
          )
          .optional(),
      }),
      outputSchema: z.object({
        sources: z.array(sourceBlockSchema),
        next_cursor: z.string().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (input) => runTool("get_messages", () => getMessages(input)),
  );
}
