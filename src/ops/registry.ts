import { getMedia } from "../media/service";
import { getChannel, listDialogs } from "../telegram/dialogs";
import { getMessage, getMessages } from "../telegram/messages";
import { getThread } from "../telegram/thread";
import { getUnreadSummary } from "../telegram/unread";
import { markRead, markUnread } from "../telegram/read-state";
import { joinChannel, leaveChannel } from "../telegram/subscriptions";
import { searchMessages } from "../telegram/search";
import { resolveTelegramUrl } from "../telegram/resolve";
import { getPinnedMessages } from "../telegram/pinned";
import { getSimilarChannels, searchChannels } from "../telegram/discovery";
import { listSourceNotes } from "../telegram/source-notes";
import type { OperationDefinition } from "./dispatch";
import {
  handleListFolders,
  handleManageFolder,
  handleSetSourceNote,
} from "./handlers";
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
  mediaOutcomeSchema,
  resolveTelegramUrlInputSchema,
  resolveTelegramUrlOutputSchema,
  searchChannelsInputSchema,
  searchChannelsOutputSchema,
  searchMessagesInputSchema,
  searchMessagesOutputSchema,
  setSourceNoteInputSchema,
  setSourceNoteOutputSchema,
} from "./schemas";

function op<I extends OperationDefinition["input"], O extends OperationDefinition["output"]>(
  definition: OperationDefinition<I, O>,
): OperationDefinition<I, O> {
  return definition;
}

export const OPERATIONS = {
  list_dialogs: op({
    name: "list_dialogs",
    input: listDialogsInputSchema,
    output: listDialogsOutputSchema,
    handler: listDialogs,
  }),
  list_folders: op({
    name: "list_folders",
    input: listFoldersInputSchema,
    output: listFoldersOutputSchema,
    handler: handleListFolders,
  }),
  get_channel: op({
    name: "get_channel",
    input: getChannelInputSchema,
    output: getChannelOutputSchema,
    handler: getChannel,
  }),
  get_messages: op({
    name: "get_messages",
    input: getMessagesInputSchema,
    output: getMessagesOutputSchema,
    handler: getMessages,
  }),
  get_message: op({
    name: "get_message",
    input: getMessageInputSchema,
    output: getMessageOutputSchema,
    handler: getMessage,
  }),
  get_media: op({
    name: "get_media",
    input: getMediaInputSchema,
    output: mediaOutcomeSchema,
    handler: (input) => getMedia(input),
  }),
  get_thread: op({
    name: "get_thread",
    input: getThreadInputSchema,
    output: getThreadOutputSchema,
    handler: getThread,
  }),
  get_unread_summary: op({
    name: "get_unread_summary",
    input: getUnreadSummaryInputSchema,
    output: getUnreadSummaryOutputSchema,
    handler: getUnreadSummary,
  }),
  mark_read: op({
    name: "mark_read",
    input: markReadInputSchema,
    output: markReadOutputSchema,
    handler: markRead,
  }),
  mark_unread: op({
    name: "mark_unread",
    input: markUnreadInputSchema,
    output: markUnreadOutputSchema,
    handler: markUnread,
  }),
  join_channel: op({
    name: "join_channel",
    input: joinChannelInputSchema,
    output: joinChannelOutputSchema,
    handler: joinChannel,
  }),
  leave_channel: op({
    name: "leave_channel",
    input: leaveChannelInputSchema,
    output: leaveChannelOutputSchema,
    handler: leaveChannel,
  }),
  manage_folder: op({
    name: "manage_folder",
    input: manageFolderInputSchema,
    output: manageFolderOutputSchema,
    handler: handleManageFolder,
  }),
  search_messages: op({
    name: "search_messages",
    input: searchMessagesInputSchema,
    output: searchMessagesOutputSchema,
    handler: searchMessages,
  }),
  resolve_telegram_url: op({
    name: "resolve_telegram_url",
    input: resolveTelegramUrlInputSchema,
    output: resolveTelegramUrlOutputSchema,
    handler: resolveTelegramUrl,
  }),
  get_pinned_messages: op({
    name: "get_pinned_messages",
    input: getPinnedMessagesInputSchema,
    output: getPinnedMessagesOutputSchema,
    handler: getPinnedMessages,
  }),
  search_channels: op({
    name: "search_channels",
    input: searchChannelsInputSchema,
    output: searchChannelsOutputSchema,
    handler: searchChannels,
  }),
  get_similar_channels: op({
    name: "get_similar_channels",
    input: getSimilarChannelsInputSchema,
    output: getSimilarChannelsOutputSchema,
    handler: getSimilarChannels,
  }),
  get_source_notes: op({
    name: "get_source_notes",
    input: getSourceNotesInputSchema,
    output: getSourceNotesOutputSchema,
    handler: listSourceNotes,
  }),
  set_source_note: op({
    name: "set_source_note",
    input: setSourceNoteInputSchema,
    output: setSourceNoteOutputSchema,
    handler: handleSetSourceNote,
  }),
};

export function operationNames(): string[] {
  return Object.keys(OPERATIONS);
}
