import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { searchMessages } from "../../telegram/search";
import { MAX_SOURCES_PER_CALL } from "../../telegram/messages";
import { MEDIA_TYPES } from "../../telegram/message-slice";
import { telegramMessageSchema } from "../../schemas/message";
import { runTool } from "../tool-result";

export function registerSearchMessages(server: McpServer): void {
  server.registerTool(
    "search_messages",
    {
      title: "Search Telegram messages",
      description:
        "Full-text search over Telegram messages. With no source_ids and no folder_ids it searches EVERY chat the account participates in, in one call. Naming source_ids or folder_ids instead searches those sources only, up to " +
        `${MAX_SOURCES_PER_CALL} of them. There is no third mode and no engine to choose: it follows from the arguments. It cannot search public channels the account has not joined — that requires Telegram Premium and costs Stars — but it CAN search inside one such channel when you name it by @username or t.me link in source_ids. Results are a flat list ordered newest first, NOT grouped by source: every hit carries chat_id and source_title, and the sources roll-up says how many hits on THIS page came from each source. total_matches is Telegram's own estimate for the whole query and drifts; use it to decide whether to narrow, not to compute with. from/to and media_type are applied by Telegram, so a filtered page is never short for that reason. exclude_source_ids works only together with source_ids or folder_ids. To continue, resend every filter unchanged with next_cursor; changing the query or a filter invalidates it. Read-only.`,
      inputSchema: z.object({
        query: z.string().min(1).describe("The text to search for."),
        source_ids: z
          .array(z.string())
          .optional()
          .describe(
            "Sources to search. Each may be a marked id from list_dialogs, a @username, or a t.me link — including channels the account has not joined.",
          ),
        folder_ids: z
          .array(z.string())
          .optional()
          .describe(
            "Folder ids from list_folders, expanded to their member sources.",
          ),
        exclude_source_ids: z
          .array(z.string())
          .optional()
          .describe(
            "Subtracted from the union of source_ids and folder_ids. Rejected without one of those, because an account-wide search cannot exclude.",
          ),
        from: z
          .string()
          .optional()
          .describe("ISO 8601. Inclusive lower bound on message date."),
        to: z
          .string()
          .optional()
          .describe("ISO 8601. Inclusive upper bound on message date."),
        media_type: z.enum(MEDIA_TYPES).optional(),
        limit: z.number().int().min(1).max(100).default(20),
        cursor: z
          .string()
          .describe(
            "Opaque continuation token from a previous response's next_cursor. Copy it back exactly as received, character for character; it is not human-readable and must not be shortened, re-typed or reconstructed. Resend the same query and filters with it.",
          )
          .optional(),
      }),
      outputSchema: z.object({
        results: z.array(
          telegramMessageSchema.extend({ source_title: z.string() }),
        ),
        sources: z.array(
          z.object({
            source_id: z.string(),
            title: z.string(),
            hit_count: z.number().int(),
            error: z
              .object({ code: z.string(), message: z.string() })
              .optional(),
          }),
        ),
        total_matches: z.number().int().optional(),
        next_cursor: z.string().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (input) => runTool("search_messages", () => searchMessages(input)),
  );
}
