import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  addFolderSources,
  createFolder,
  deleteFolder,
  removeFolderSources,
  renameFolder,
  reorderFolders,
  MAX_FOLDERS,
  MAX_FOLDER_SOURCES,
} from "../../telegram/folder-edit";
import { MAX_SOURCES_PER_CALL } from "../../telegram/source-selection";
import { telegramFolderSchema } from "../../schemas/folder";
import { GramScopeError } from "../../errors/taxonomy";
import { runTool } from "../tool-result";

type ManageFolderInput = {
  action:
    | "create"
    | "rename"
    | "delete"
    | "add_sources"
    | "remove_sources"
    | "reorder";
  folder_id?: string;
  title?: string;
  source_ids?: string[];
  folder_ids?: string[];
};

function required<T>(value: T | undefined, name: string, action: string): T {
  if (value === undefined) {
    throw new GramScopeError(
      "INVALID_INPUT",
      `manage_folder(${action}) requires ${name}.`,
    );
  }
  return value;
}

async function run(input: ManageFolderInput) {
  const { action } = input;
  switch (action) {
    case "create":
      return {
        action,
        folder: await createFolder({
          title: required(input.title, "title", action),
          ...(input.source_ids ? { source_ids: input.source_ids } : {}),
        }),
      };
    case "rename":
      return {
        action,
        folder: await renameFolder({
          folder_id: required(input.folder_id, "folder_id", action),
          title: required(input.title, "title", action),
        }),
      };
    case "delete":
      return {
        action,
        ...(await deleteFolder({
          folder_id: required(input.folder_id, "folder_id", action),
        })),
      };
    case "add_sources":
      return {
        action,
        folder: await addFolderSources({
          folder_id: required(input.folder_id, "folder_id", action),
          source_ids: required(input.source_ids, "source_ids", action),
        }),
      };
    case "remove_sources":
      return {
        action,
        folder: await removeFolderSources({
          folder_id: required(input.folder_id, "folder_id", action),
          source_ids: required(input.source_ids, "source_ids", action),
        }),
      };
    case "reorder":
      return {
        action,
        folders: await reorderFolders({
          folder_ids: required(input.folder_ids, "folder_ids", action),
        }),
      };
  }
}

export function registerManageFolder(server: McpServer): void {
  server.registerTool(
    "manage_folder",
    {
      title: "Manage Telegram folders",
      description:
        "Create, rename, delete and reorder the account's chat folders, and move sources in and out of them. This CHANGES ACCOUNT STATE. Folders are this account's working lanes, so filing sources into them is how later reads get narrowed with list_dialogs(folder_id). delete removes one folder per call and does not touch the chats in it. " +
        `An account holds at most ${MAX_FOLDERS} folders and a folder at most ${MAX_FOLDER_SOURCES} sources; add_sources and remove_sources take at most ${MAX_SOURCES_PER_CALL} sources per call. reorder takes the complete list of folder ids. A shareable folder cannot be edited here.`,
      inputSchema: z.object({
        action: z.enum([
          "create",
          "rename",
          "delete",
          "add_sources",
          "remove_sources",
          "reorder",
        ]),
        folder_id: z
          .string()
          .optional()
          .describe("Required by rename, delete, add_sources, remove_sources."),
        title: z
          .string()
          .optional()
          .describe("Required by create and rename."),
        source_ids: z
          .array(z.string())
          .max(MAX_SOURCES_PER_CALL)
          .optional()
          .describe(
            "Required by add_sources and remove_sources; optional on create. Numeric ids, @usernames or t.me links.",
          ),
        folder_ids: z
          .array(z.string())
          .optional()
          .describe(
            "Required by reorder: every folder id the account holds, exactly once, in the wanted order.",
          ),
      }),
      outputSchema: z.object({
        action: z.string(),
        folder: telegramFolderSchema.optional(),
        folders: z.array(telegramFolderSchema).optional(),
        deleted_folder_id: z.string().optional(),
        title: z.string().optional(),
      }),
      annotations: { readOnlyHint: false },
    },
    async (input) =>
      runTool("manage_folder", () => run(input as ManageFolderInput)),
  );
}
