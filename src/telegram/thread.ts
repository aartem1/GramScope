import { getApi, withTelegram } from "./client";
import { fetchDialogIndex } from "./dialog-index";
import { resolveSource } from "./peer-resolve";
import { markedChannelId, readBigId } from "./peer-id";
import { readMessagesPage } from "./tl-messages";
import {
  assertSameScope,
  decodeThreadCursor,
  encodeThreadCursor,
  scopeFingerprint,
} from "../pagination";
import { fitToSizeCap } from "../schemas/size";
import { GramScopeError } from "../errors/taxonomy";
import {
  mapMessage,
  type MessageContext,
  type TelegramMessage,
} from "../schemas/message";

export type GetThreadInput = {
  source_id: string;
  post_id: number;
  limit: number;
  cursor?: string;
};

export type GetThreadResult = {
  source_id: string;
  source_title: string;
  post: TelegramMessage;
  discussion_chat_id?: string;
  comment_count: number;
  comments: TelegramMessage[];
  next_cursor?: string;
};

export async function getThread(
  input: GetThreadInput,
): Promise<GetThreadResult> {
  const index = await fetchDialogIndex();

  return withTelegram(async (client) => {
    const source = await resolveSource(client, index, input.source_id);
    const fingerprint = scopeFingerprint({
      source: source.source_id,
      post: input.post_id,
    });
    const cursor = input.cursor ? decodeThreadCursor(input.cursor) : undefined;
    if (cursor) assertSameScope(cursor.fingerprint, fingerprint);

    const found = await client.getMessages(source.handle, {
      ids: [input.post_id],
    });
    const raw = (found[0] ?? undefined) as Record<string, unknown> | undefined;
    if (
      !raw ||
      typeof raw.id !== "number" ||
      raw.className === "MessageEmpty"
    ) {
      throw new GramScopeError(
        "MESSAGE_NOT_FOUND",
        `No message ${input.post_id} in ${source.source_id}`,
      );
    }

    const entry = index.byId.get(source.source_id);
    const postContext: MessageContext = {
      chatId: source.source_id,
      ...(source.username !== undefined ? { username: source.username } : {}),
      ...(entry !== undefined
        ? { readInboxMaxId: entry.read_inbox_max_id }
        : {}),
    };

    // The post's replies block is the only thing that distinguishes a channel
    // without a discussion group from a post with no comments.
    const replies = (raw.replies ?? undefined) as
      | Record<string, unknown>
      | undefined;
    if (!replies || typeof replies.replies !== "number") {
      throw new GramScopeError(
        "NO_DISCUSSION_THREAD",
        `${source.title} has no linked discussion group, so its posts carry no comment threads.`,
      );
    }

    const linkedBare = readBigId(replies.channelId);
    const base = {
      source_id: source.source_id,
      source_title: source.title,
      post: mapMessage(raw, postContext),
      ...(linkedBare !== undefined
        ? { discussion_chat_id: markedChannelId(linkedBare) }
        : {}),
    };

    if (replies.replies === 0) {
      return { ...base, comment_count: 0, comments: [] };
    }

    const Api = await getApi();
    const page = readMessagesPage(
      await client.invoke(
        new Api.messages.GetReplies({
          peer: source.handle as never,
          msgId: input.post_id,
          offsetId: cursor?.offsetId ?? 0,
          offsetDate: 0,
          addOffset: 0,
          limit: input.limit,
          maxId: 0,
          minId: 0,
          hash: 0 as never,
        }),
      ),
    );

    // An unjoined discussion group has no read pointer, so comments must not
    // carry is_read or a guessed public URL.
    const commentContext: MessageContext = {
      chatId: base.discussion_chat_id ?? source.source_id,
    };
    const all = page.messages.map((message) =>
      mapMessage(message, commentContext),
    );

    const comment_count = page.count ?? replies.replies;
    const fit = fitToSizeCap(all, (kept) => ({
      ...base,
      comment_count,
      comments: kept,
    }));
    const comments = all.slice(0, fit);

    const exhausted = comments.length === all.length && all.length < input.limit;
    const oldest = comments[comments.length - 1];

    return {
      ...base,
      comment_count,
      comments,
      ...(exhausted || oldest === undefined
        ? {}
        : {
            next_cursor: encodeThreadCursor({
              offsetId: oldest.id,
              fingerprint,
            }),
          }),
    };
  });
}
