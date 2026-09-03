import type { McpServer } from "@modelcontextprotocol/server";
import {
  listDialogs,
  listDialogsInputSchema,
  listDialogsOutputSchema,
} from "../../ops";
import { runTool } from "../tool-result";

export function registerListDialogs(server: McpServer): void {
  server.registerTool(
    "list_dialogs",
    {
      title: "List Telegram sources",
      description:
        "List channels, groups and chats on the account, with unread counts and folder membership. Filtering by folder_id honors the folder's included and excluded peers only; it ignores the folder's exclude-muted, exclude-read and chat-type flags, so results may differ from the folder tab in the Telegram app. Paginate with next_cursor. Read-only: this does not mark anything as read.",
      inputSchema: listDialogsInputSchema,
      outputSchema: listDialogsOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => runTool("list_dialogs", () => listDialogs(input)),
  );
}
