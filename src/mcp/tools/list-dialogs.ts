import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { listDialogs } from "../../telegram/dialogs";
import { telegramSourceSchema } from "../../schemas/source";
import { runTool } from "../tool-result";

export function registerListDialogs(server: McpServer): void {
  server.registerTool(
    "list_dialogs",
    {
      title: "List Telegram sources",
      description:
        "List channels, groups and chats on the account, with unread counts and folder membership. Filtering by folder_id honors the folder's included and excluded peers only; it ignores the folder's exclude-muted, exclude-read and chat-type flags, so results may differ from the folder tab in the Telegram app. Paginate with next_cursor. Read-only: this does not mark anything as read.",
      inputSchema: z.object({
        folder_id: z.string().optional(),
        unread_only: z.boolean().optional(),
        type: z.enum(["channel", "group", "chat"]).optional(),
        limit: z.number().int().min(1).max(200).default(50),
        cursor: z.string().optional(),
      }),
      outputSchema: z.object({
        sources: z.array(telegramSourceSchema),
        next_cursor: z.string().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (input) => runTool("list_dialogs", () => listDialogs(input)),
  );
}
