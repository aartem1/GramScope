import { GramScopeError } from "../errors/taxonomy";
import { fetchFolders } from "../telegram/folders";
import {
  addFolderSources,
  createFolder,
  deleteFolder,
  removeFolderSources,
  renameFolder,
  reorderFolders,
} from "../telegram/folder-edit";
import { deleteSourceNote, setSourceNote } from "../telegram/source-notes";
import type { z } from "zod";
import type { manageFolderInputSchema, setSourceNoteInputSchema } from "./schemas";

type ManageFolderInput = z.output<typeof manageFolderInputSchema>;
type SetSourceNoteInput = z.output<typeof setSourceNoteInputSchema>;

export async function handleListFolders() {
  return { folders: await fetchFolders() };
}

function required<T>(value: T | undefined, name: string, action: string): T {
  if (value === undefined) {
    throw new GramScopeError(
      "INVALID_INPUT",
      `manage_folder(${action}) requires ${name}.`,
    );
  }
  return value;
}

export async function handleManageFolder(input: ManageFolderInput) {
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

export async function handleSetSourceNote(input: SetSourceNoteInput) {
  if (input.action === "delete") {
    return deleteSourceNote(input.source_id);
  }
  if (!input.about || !input.topics || !input.kind) {
    throw new GramScopeError(
      "INVALID_INPUT",
      "action 'set' requires about, topics and kind.",
    );
  }
  return setSourceNote({
    source_id: input.source_id,
    about: input.about,
    topics: input.topics,
    kind: input.kind,
    ...(input.lang ? { lang: input.lang } : {}),
    ...(input.cadence ? { cadence: input.cadence } : {}),
    ...(input.derived_from ? { derived_from: input.derived_from } : {}),
  });
}
