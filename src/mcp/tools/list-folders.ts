import type { McpServer } from "@modelcontextprotocol/server";
import {
  listFolders,
  listFoldersInputSchema,
  listFoldersOutputSchema,
} from "../../ops";
import { runTool } from "../tool-result";

export function registerListFolders(server: McpServer): void {
  server.registerTool(
    "list_folders",
    {
      title: "List Telegram folders",
      description:
        "List the Telegram chat folders (dialog filters) on the account, with the peers each includes and excludes. Use the returned id as folder_id for list_dialogs. Read-only.",
      inputSchema: listFoldersInputSchema,
      outputSchema: listFoldersOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => runTool("list_folders", () => listFolders(input)),
  );
}
