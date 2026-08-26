import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { fetchFolders } from "../../telegram/folders";
import { telegramFolderSchema } from "../../schemas/folder";
import { runTool } from "../tool-result";

export function registerListFolders(server: McpServer): void {
  server.registerTool(
    "list_folders",
    {
      title: "List Telegram folders",
      description:
        "List the Telegram chat folders (dialog filters) on the account, with the peers each includes and excludes. Use the returned id as folder_id for list_dialogs. Read-only.",
      inputSchema: z.object({}),
      outputSchema: z.object({ folders: z.array(telegramFolderSchema) }),
      annotations: { readOnlyHint: true },
    },
    async () => runTool("list_folders", async () => ({
      folders: await fetchFolders(),
    })),
  );
}
