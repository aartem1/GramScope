import { z } from "zod";
import { telegramSourceSchema } from "../schemas/source";
import { telegramFolderSchema } from "../schemas/folder";
import { telegramMessageSchema } from "../schemas/message";
import { sourceNoteSchema, NOTE_KINDS } from "../schemas/source-note";
import {
  searchChannelsResultSchema,
  similarChannelsResultSchema,
} from "../schemas/discovery";
import {
  getMediaInputSchema,
  getMediaResultSchema,
} from "../schemas/media";
import { unsignedMediaClaimsSchema } from "../media/token";
import {
  MAX_CONTEXT,
  MAX_FOLDER_TITLE,
  MAX_MARK_READ_SOURCES,
  MAX_SOURCES_PER_CALL,
  MEDIA_TYPES,
} from "../limits";
import { MAX_ENRICHED_CANDIDATES } from "../telegram/discovery";

export const listDialogsInputSchema = z.object({
  folder_id: z.string().optional(),
  unread_only: z.boolean().optional(),
  type: z.enum(["channel", "group", "chat"]).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z
    .string()
    .describe(
      "Opaque continuation token from a previous response's next_cursor. Copy it back exactly as received, character for character; it is not human-readable and must not be shortened, re-typed or reconstructed.",
    )
    .optional(),
});

export const listDialogsOutputSchema = z.object({
  sources: z.array(telegramSourceSchema),
  next_cursor: z.string().optional(),
});

export const listFoldersInputSchema = z.object({});

export const listFoldersOutputSchema = z.object({
  folders: z.array(telegramFolderSchema),
});

export const getChannelInputSchema = z.object({
  id: z
    .string()
    .optional()
    .describe(
      "Numeric peer id as returned by list_dialogs. Provide exactly one of id, username, or url.",
    ),
  username: z
    .string()
    .optional()
    .describe(
      "Public @username, with or without the @. Provide exactly one of id, username, or url.",
    ),
  url: z
    .string()
    .optional()
    .describe(
      "A t.me link, e.g. https://t.me/example. Provide exactly one of id, username, or url.",
    ),
});

export const getChannelOutputSchema = telegramSourceSchema;

export const sourceBlockSchema = z.object({
  source_id: z.string(),
  title: z.string(),
  messages: z.array(telegramMessageSchema).optional(),
  has_more: z.boolean().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});

export const getMessagesInputSchema = z.object({
  source_ids: z
    .array(z.string())
    .optional()
    .describe(
      "Sources to read. Each may be a marked id from list_dialogs, a @username, or a t.me link — including a public channel the account has not joined, which then reports no unread state.",
    ),
  folder_ids: z
    .array(z.string())
    .optional()
    .describe(
      "Folder ids from list_folders, expanded to their member sources.",
    ),
  exclude_source_ids: z
    .array(z.string())
    .optional()
    .describe("Subtracted from the union of source_ids and folder_ids."),
  from: z
    .string()
    .optional()
    .describe("ISO 8601. Inclusive lower bound on message date."),
  to: z
    .string()
    .optional()
    .describe("ISO 8601. Inclusive upper bound on message date."),
  unread_only: z
    .boolean()
    .optional()
    .describe("Return only messages above each source's read pointer."),
  media_type: z.enum(MEDIA_TYPES).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z
    .string()
    .describe(
      "Opaque continuation token from a previous response's next_cursor. Copy it back exactly as received, character for character; it is not human-readable and must not be shortened, re-typed or reconstructed.",
    )
    .optional(),
});

export const getMessagesOutputSchema = z.object({
  sources: z.array(sourceBlockSchema),
  next_cursor: z.string().optional(),
});

export const getMessageInputSchema = z.object({
  source_id: z
    .string()
    .describe(
      "A marked id from list_dialogs, a @username, or a t.me link.",
    ),
  message_id: z.number().int(),
  context_before: z
    .number()
    .int()
    .min(0)
    .max(MAX_CONTEXT)
    .default(0)
    .describe("How many older messages to include."),
  context_after: z
    .number()
    .int()
    .min(0)
    .max(MAX_CONTEXT)
    .default(0)
    .describe("How many newer messages to include."),
});

export const getMessageOutputSchema = z.object({
  source_id: z.string(),
  source_title: z.string(),
  message: telegramMessageSchema,
  context_before: z.array(telegramMessageSchema),
  context_after: z.array(telegramMessageSchema),
});

export { getMediaInputSchema, getMediaResultSchema };

export const mediaOutcomeSchema = z.object({
  result: getMediaResultSchema,
  link: z
    .object({
      uri: z.string().optional(),
      name: z.string(),
      mimeType: z.string().optional(),
      size: z.number().optional(),
    })
    .optional(),
  unsignedClaims: unsignedMediaClaimsSchema.optional(),
});

export const getThreadInputSchema = z.object({
  source_id: z
    .string()
    .describe(
      "The CHANNEL the post is in — a marked id, a @username, or a t.me link. Not the discussion group.",
    ),
  post_id: z
    .number()
    .int()
    .describe("Message id of the post inside that channel."),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z
    .string()
    .describe(
      "Opaque continuation token from a previous response's next_cursor. Copy it back exactly as received, character for character; it is not human-readable and must not be shortened, re-typed or reconstructed. It is bound to this source_id and post_id.",
    )
    .optional(),
});

export const getThreadOutputSchema = z.object({
  source_id: z.string(),
  source_title: z.string(),
  post: telegramMessageSchema,
  discussion_chat_id: z.string().optional(),
  comment_count: z.number().int(),
  comments: z.array(telegramMessageSchema),
  next_cursor: z.string().optional(),
});

export const getUnreadSummaryInputSchema = z.object({
  group_by: z.enum(["source", "folder"]).default("source"),
  folder_ids: z
    .array(z.string())
    .optional()
    .describe("Narrow the report to these folders."),
});

export const getUnreadSummaryOutputSchema = z.object({
  groups: z.array(
    z.object({
      source_id: z.string().optional(),
      folder_id: z.string().optional(),
      title: z.string(),
      unread_count: z.number().int(),
      read_inbox_max_id: z.number().int().optional(),
      latest_message_id: z.number().int().optional(),
      latest_message_date: z.string().optional(),
      unread_mark: z.boolean().optional(),
    }),
  ),
  total_unread: z.number().int(),
});

export const markReadInputSchema = z.object({
  source_ids: z.array(z.string()).min(1).max(MAX_MARK_READ_SOURCES),
  up_to_message_id: z
    .number()
    .int()
    .optional()
    .describe(
      "Mark read through this message id. Omit to use each source's latest message.",
    ),
});

export const markReadOutputSchema = z.object({
  results: z.array(
    z.object({
      source_id: z.string(),
      read_inbox_max_id: z.number().int(),
    }),
  ),
  failures: z.array(
    z.object({
      source_id: z.string(),
      code: z.string(),
      message: z.string(),
    }),
  ),
});

export const markUnreadInputSchema = z.object({
  source_ids: z.array(z.string()).min(1).max(MAX_MARK_READ_SOURCES),
  unread: z
    .boolean()
    .default(true)
    .describe("true sets the flag; false clears it."),
});

export const markUnreadOutputSchema = z.object({
  results: z.array(
    z.object({
      source_id: z.string(),
      unread_mark: z.boolean(),
    }),
  ),
  failures: z.array(
    z.object({
      source_id: z.string(),
      code: z.string(),
      message: z.string(),
    }),
  ),
});

export const joinChannelInputSchema = z.object({
  source: z
    .string()
    .describe(
      "One @username or t.me link. A bare numeric id resolves only for chats the account already belongs to, so it cannot name something to join.",
    ),
});

export const joinChannelOutputSchema = z.object({
  source: telegramSourceSchema,
  already_member: z.boolean(),
});

export const leaveChannelInputSchema = z.object({
  source: z
    .string()
    .describe("One source: numeric id, @username, or t.me link."),
});

export const leaveChannelOutputSchema = z.object({
  source: telegramSourceSchema,
  was_member: z.boolean(),
});

export const manageFolderInputSchema = z.object({
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
    .max(MAX_FOLDER_TITLE)
    .optional()
    .describe(
      `Required by create and rename. At most ${MAX_FOLDER_TITLE} characters; Telegram rejects a longer folder title.`,
    ),
  source_ids: z
    .array(z.string())
    .max(MAX_SOURCES_PER_CALL)
    .optional()
    .describe(
      "Required by create, add_sources and remove_sources. create and add_sources take marked ids, @usernames or t.me links; remove_sources takes only the marked ids list_folders reports in included_peer_ids, because it matches them without resolving anything.",
    ),
  folder_ids: z
    .array(z.string())
    .optional()
    .describe(
      "Required by reorder: every folder id the account holds, exactly once, in the wanted order.",
    ),
});

export const manageFolderOutputSchema = z.object({
  action: z.string(),
  folder: telegramFolderSchema.optional(),
  folders: z.array(telegramFolderSchema).optional(),
  deleted_folder_id: z.string().optional(),
  title: z.string().optional(),
});

export const searchMessagesInputSchema = z.object({
  query: z.string().min(1).describe("The text to search for."),
  source_ids: z
    .array(z.string())
    .optional()
    .describe(
      "Sources to search. Each may be a marked id from list_dialogs, a @username, or a t.me link — including channels the account has not joined.",
    ),
  folder_ids: z
    .array(z.string())
    .optional()
    .describe(
      "Folder ids from list_folders, expanded to their member sources.",
    ),
  exclude_source_ids: z
    .array(z.string())
    .optional()
    .describe(
      "Subtracted from the union of source_ids and folder_ids. Rejected without one of those, because an account-wide search cannot exclude.",
    ),
  from: z
    .string()
    .optional()
    .describe("ISO 8601. Inclusive lower bound on message date."),
  to: z
    .string()
    .optional()
    .describe("ISO 8601. Inclusive upper bound on message date."),
  media_type: z.enum(MEDIA_TYPES).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z
    .string()
    .describe(
      "Opaque continuation token from a previous response's next_cursor. Copy it back exactly as received, character for character; it is not human-readable and must not be shortened, re-typed or reconstructed. Resend the same query and filters with it.",
    )
    .optional(),
});

export const searchMessagesOutputSchema = z.object({
  results: z.array(telegramMessageSchema.extend({ source_title: z.string() })),
  sources: z.array(
    z.object({
      source_id: z.string(),
      title: z.string(),
      hit_count: z.number().int(),
      error: z.object({ code: z.string(), message: z.string() }).optional(),
    }),
  ),
  total_matches: z.number().int().optional(),
  next_cursor: z.string().optional(),
});

export const resolveTelegramUrlInputSchema = z.object({
  url: z
    .string()
    .min(1)
    .describe("A t.me link, a @username, or a bare channel name."),
});

export const resolveTelegramUrlOutputSchema = z.object({
  kind: z.enum(["source", "post", "invite"]),
  source: z
    .object({
      source_id: z.string().optional(),
      title: z.string(),
      username: z.string().optional(),
      type: z.enum(["channel", "group", "chat"]),
      subscriber_count: z.number().int().optional(),
      linked_discussion_id: z.string().optional(),
      joined: z.boolean(),
      folder_ids: z.array(z.string()).optional(),
    })
    .optional(),
  message_id: z.number().int().optional(),
  comment_id: z.number().int().optional(),
});

export const getPinnedMessagesInputSchema = z.object({
  source_id: z
    .string()
    .describe("A marked id, a @username, or a t.me link."),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z
    .string()
    .describe(
      "Opaque continuation token from a previous response's next_cursor. Copy it back exactly as received, character for character; it is not human-readable and must not be shortened, re-typed or reconstructed. It is bound to this source_id.",
    )
    .optional(),
});

export const getPinnedMessagesOutputSchema = z.object({
  source_id: z.string(),
  source_title: z.string(),
  messages: z.array(telegramMessageSchema),
  next_cursor: z.string().optional(),
});

export const searchChannelsInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "Words from the channel's name or its @username. Not a topic: use the fullest name you know.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_ENRICHED_CANDIDATES)
    .optional()
    .describe("How many candidates to return. 1-10, default 10."),
});

export const searchChannelsOutputSchema = searchChannelsResultSchema;

export const getSimilarChannelsInputSchema = z.object({
  source: z
    .string()
    .optional()
    .describe(
      "The channel to find neighbours of — marked id, @username, or t.me link. Omit it to get recommendations for the whole account.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_ENRICHED_CANDIDATES)
    .optional()
    .describe("How many candidates to return. 1-10, default 10."),
});

export const getSimilarChannelsOutputSchema = similarChannelsResultSchema;

export const getSourceNotesInputSchema = z.object({
  source_ids: z.array(z.string()).max(MAX_SOURCES_PER_CALL).optional(),
  query: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});

export const getSourceNotesOutputSchema = z.object({
  notes: z.array(sourceNoteSchema),
  duplicates: z.array(
    z.object({
      source_id: z.string(),
      message_ids: z.array(z.number().int()),
    }),
  ),
  malformed: z.array(
    z.object({
      message_id: z.number().int(),
      reason: z.string(),
    }),
  ),
  next_cursor: z.string().optional(),
});

export const setSourceNoteInputSchema = z.object({
  action: z.enum(["set", "delete"]).default("set"),
  source_id: z.string(),
  about: z.string().optional(),
  topics: z.array(z.string()).optional(),
  kind: z.enum(NOTE_KINDS).optional(),
  lang: z.string().optional(),
  cadence: z.string().optional(),
  derived_from: z
    .string()
    .optional()
    .describe(
      "What the note was made from, e.g. a message id range or 'last 40 posts'. With updated, this is how a stale note becomes visible.",
    ),
});

export const setSourceNoteOutputSchema = z.object({
  note: sourceNoteSchema.optional(),
  replaced: z.boolean().optional(),
  deleted: z.boolean().optional(),
});
