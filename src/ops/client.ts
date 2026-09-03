import type { z } from "zod";
import type { MediaOutcome } from "../media/service";
import { createDispatcher } from "./dispatch";
import { OPERATIONS } from "./registry";
import {
  getChannelInputSchema,
  getChannelOutputSchema,
  getMediaInputSchema,
  getMessageInputSchema,
  getMessageOutputSchema,
  getMessagesInputSchema,
  getMessagesOutputSchema,
  getPinnedMessagesInputSchema,
  getPinnedMessagesOutputSchema,
  getSimilarChannelsInputSchema,
  getSimilarChannelsOutputSchema,
  getSourceNotesInputSchema,
  getSourceNotesOutputSchema,
  getThreadInputSchema,
  getThreadOutputSchema,
  getUnreadSummaryInputSchema,
  getUnreadSummaryOutputSchema,
  joinChannelInputSchema,
  joinChannelOutputSchema,
  leaveChannelInputSchema,
  leaveChannelOutputSchema,
  listDialogsInputSchema,
  listDialogsOutputSchema,
  listFoldersInputSchema,
  listFoldersOutputSchema,
  manageFolderInputSchema,
  manageFolderOutputSchema,
  markReadInputSchema,
  markReadOutputSchema,
  markUnreadInputSchema,
  markUnreadOutputSchema,
  resolveTelegramUrlInputSchema,
  resolveTelegramUrlOutputSchema,
  searchChannelsInputSchema,
  searchChannelsOutputSchema,
  searchMessagesInputSchema,
  searchMessagesOutputSchema,
  setSourceNoteInputSchema,
  setSourceNoteOutputSchema,
} from "./schemas";

export const dispatch = createDispatcher(OPERATIONS);

type In<S extends z.ZodType> = z.input<S>;
type Out<S extends z.ZodType> = z.output<S>;

export async function listDialogs(
  input: In<typeof listDialogsInputSchema>,
): Promise<Out<typeof listDialogsOutputSchema>> {
  return dispatch("list_dialogs", input) as Promise<
    Out<typeof listDialogsOutputSchema>
  >;
}

export async function listFolders(
  input: In<typeof listFoldersInputSchema> = {},
): Promise<Out<typeof listFoldersOutputSchema>> {
  return dispatch("list_folders", input) as Promise<
    Out<typeof listFoldersOutputSchema>
  >;
}

export async function getChannel(
  input: In<typeof getChannelInputSchema>,
): Promise<Out<typeof getChannelOutputSchema>> {
  return dispatch("get_channel", input) as Promise<
    Out<typeof getChannelOutputSchema>
  >;
}

export async function getMessages(
  input: In<typeof getMessagesInputSchema>,
): Promise<Out<typeof getMessagesOutputSchema>> {
  return dispatch("get_messages", input) as Promise<
    Out<typeof getMessagesOutputSchema>
  >;
}

export async function getMessage(
  input: In<typeof getMessageInputSchema>,
): Promise<Out<typeof getMessageOutputSchema>> {
  return dispatch("get_message", input) as Promise<
    Out<typeof getMessageOutputSchema>
  >;
}

export async function getMedia(
  input: In<typeof getMediaInputSchema>,
): Promise<MediaOutcome> {
  return dispatch("get_media", input) as Promise<MediaOutcome>;
}

export async function getThread(
  input: In<typeof getThreadInputSchema>,
): Promise<Out<typeof getThreadOutputSchema>> {
  return dispatch("get_thread", input) as Promise<
    Out<typeof getThreadOutputSchema>
  >;
}

export async function getUnreadSummary(
  input: In<typeof getUnreadSummaryInputSchema>,
): Promise<Out<typeof getUnreadSummaryOutputSchema>> {
  return dispatch("get_unread_summary", input) as Promise<
    Out<typeof getUnreadSummaryOutputSchema>
  >;
}

export async function markRead(
  input: In<typeof markReadInputSchema>,
): Promise<Out<typeof markReadOutputSchema>> {
  return dispatch("mark_read", input) as Promise<
    Out<typeof markReadOutputSchema>
  >;
}

export async function markUnread(
  input: In<typeof markUnreadInputSchema>,
): Promise<Out<typeof markUnreadOutputSchema>> {
  return dispatch("mark_unread", input) as Promise<
    Out<typeof markUnreadOutputSchema>
  >;
}

export async function joinChannel(
  input: In<typeof joinChannelInputSchema>,
): Promise<Out<typeof joinChannelOutputSchema>> {
  return dispatch("join_channel", input) as Promise<
    Out<typeof joinChannelOutputSchema>
  >;
}

export async function leaveChannel(
  input: In<typeof leaveChannelInputSchema>,
): Promise<Out<typeof leaveChannelOutputSchema>> {
  return dispatch("leave_channel", input) as Promise<
    Out<typeof leaveChannelOutputSchema>
  >;
}

export async function manageFolder(
  input: In<typeof manageFolderInputSchema>,
): Promise<Out<typeof manageFolderOutputSchema>> {
  return dispatch("manage_folder", input) as Promise<
    Out<typeof manageFolderOutputSchema>
  >;
}

export async function searchMessages(
  input: In<typeof searchMessagesInputSchema>,
): Promise<Out<typeof searchMessagesOutputSchema>> {
  return dispatch("search_messages", input) as Promise<
    Out<typeof searchMessagesOutputSchema>
  >;
}

export async function resolveTelegramUrl(
  input: In<typeof resolveTelegramUrlInputSchema>,
): Promise<Out<typeof resolveTelegramUrlOutputSchema>> {
  return dispatch("resolve_telegram_url", input) as Promise<
    Out<typeof resolveTelegramUrlOutputSchema>
  >;
}

export async function getPinnedMessages(
  input: In<typeof getPinnedMessagesInputSchema>,
): Promise<Out<typeof getPinnedMessagesOutputSchema>> {
  return dispatch("get_pinned_messages", input) as Promise<
    Out<typeof getPinnedMessagesOutputSchema>
  >;
}

export async function searchChannels(
  input: In<typeof searchChannelsInputSchema>,
): Promise<Out<typeof searchChannelsOutputSchema>> {
  return dispatch("search_channels", input) as Promise<
    Out<typeof searchChannelsOutputSchema>
  >;
}

export async function getSimilarChannels(
  input: In<typeof getSimilarChannelsInputSchema>,
): Promise<Out<typeof getSimilarChannelsOutputSchema>> {
  return dispatch("get_similar_channels", input) as Promise<
    Out<typeof getSimilarChannelsOutputSchema>
  >;
}

export async function listSourceNotes(
  input: In<typeof getSourceNotesInputSchema>,
): Promise<Out<typeof getSourceNotesOutputSchema>> {
  return dispatch("get_source_notes", input) as Promise<
    Out<typeof getSourceNotesOutputSchema>
  >;
}

export async function setSourceNote(
  input: In<typeof setSourceNoteInputSchema>,
): Promise<Out<typeof setSourceNoteOutputSchema>> {
  return dispatch("set_source_note", input) as Promise<
    Out<typeof setSourceNoteOutputSchema>
  >;
}

export type { MediaOutcome };
