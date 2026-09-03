import type { McpServer } from "@modelcontextprotocol/server";
import { MAX_SOURCES_PER_CALL } from "../../limits";
import {
  searchMessages,
  searchMessagesInputSchema,
  searchMessagesOutputSchema,
} from "../../ops";
import { runTool } from "../tool-result";

export function registerSearchMessages(server: McpServer): void {
  server.registerTool(
    "search_messages",
    {
      title: "Search Telegram messages",
      description:
        "Full-text search over Telegram messages. With no source_ids and no folder_ids it searches EVERY chat the account participates in, in one call. Naming source_ids or folder_ids instead searches those sources only, up to " +
        `${MAX_SOURCES_PER_CALL} of them. There is no third mode and no engine to choose: it follows from the arguments. It cannot search public channels the account has not joined — that requires Telegram Premium and costs Stars — but it CAN search inside one such channel when you name it by @username or t.me link in source_ids. Results are a flat list ordered newest first, NOT grouped by source: every hit carries chat_id and source_title, and the sources roll-up says how many hits on THIS page came from each source. total_matches is Telegram's own estimate for the whole query and drifts; use it to decide whether to narrow, not to compute with. from/to and media_type are applied by Telegram, so a filtered page is never short for that reason. exclude_source_ids works only together with source_ids or folder_ids. To continue, resend every filter unchanged with next_cursor; changing the query or a filter invalidates it. Read-only.`,
      inputSchema: searchMessagesInputSchema,
      outputSchema: searchMessagesOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => runTool("search_messages", () => searchMessages(input)),
  );
}
