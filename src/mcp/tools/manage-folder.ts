import type { McpServer } from "@modelcontextprotocol/server";
import {
  MAX_FOLDER_SOURCES,
  MAX_FOLDER_TITLE,
  MAX_FOLDERS,
  MAX_SOURCES_PER_CALL,
} from "../../limits";
import {
  manageFolder,
  manageFolderInputSchema,
  manageFolderOutputSchema,
} from "../../ops";
import { runTool } from "../tool-result";

export function registerManageFolder(server: McpServer): void {
  server.registerTool(
    "manage_folder",
    {
      title: "Manage Telegram folders",
      description:
        "Create, rename, delete and reorder the account's chat folders, and move sources in and out of them. This CHANGES ACCOUNT STATE. Folders are this account's working lanes, so filing sources into them is how later reads get narrowed with list_dialogs(folder_id). delete removes one folder per call and does not touch the chats in it. " +
        `An account holds at most ${MAX_FOLDERS} folders, a folder title at most ${MAX_FOLDER_TITLE} characters, and a folder at most ${MAX_FOLDER_SOURCES} sources; create, add_sources and remove_sources take at most ${MAX_SOURCES_PER_CALL} sources per call. create must name at least one source: Telegram rejects an empty folder. reorder takes the complete list of folder ids. A shareable folder cannot be edited here.`,
      inputSchema: manageFolderInputSchema,
      outputSchema: manageFolderOutputSchema,
      annotations: { readOnlyHint: false },
    },
    async (input) => runTool("manage_folder", () => manageFolder(input)),
  );
}
