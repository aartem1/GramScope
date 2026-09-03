import { FANOUT_CONCURRENCY, mapWithConcurrency } from "../concurrency";
import { mapTelegramError } from "../errors/from-telegram";
import { GramScopeError } from "../errors/taxonomy";
import { MAX_MARK_READ_SOURCES } from "../limits";
import { getApi, resolveEntity, toInputPeer, withTelegram } from "./client";
import { fetchDialogIndex } from "./dialog-index";
import { assertSourceIdsBounded } from "./source-selection";

export { MAX_MARK_READ_SOURCES } from "../limits";

export type MarkReadInput = {
  source_ids: string[];
  up_to_message_id?: number;
};

export type MarkReadSuccess = {
  source_id: string;
  read_inbox_max_id: number;
};

export type MarkReadFailure = {
  source_id: string;
  code: string;
  message: string;
};

export type MarkReadResult = {
  results: MarkReadSuccess[];
  failures: MarkReadFailure[];
};

/**
 * Advances a source's read pointer to an explicit or implied message id —
 * one of the two mutating engines this file holds; markUnread below is the
 * sibling that sets or clears the manual unread flag instead.
 *
 * Peers resolve exactly as reads do. Task 1 verified live that Telegram
 * accepts channels.ReadHistory for channels resolved from marked ids.
 */
export async function markRead(
  input: MarkReadInput,
): Promise<MarkReadResult> {
  assertSourceIdsBounded(input.source_ids, "mark_read", MAX_MARK_READ_SOURCES);

  const index = await fetchDialogIndex();
  const outcomes = await withTelegram(async (client) => {
    const Api = await getApi();
    return mapWithConcurrency(
      input.source_ids,
      FANOUT_CONCURRENCY,
      async (sourceId): Promise<MarkReadSuccess | MarkReadFailure> => {
        try {
          const maxId =
            input.up_to_message_id ??
            index.byId.get(sourceId)?.latest_message_id;
          if (maxId === undefined) {
            throw new GramScopeError(
              "CHANNEL_NOT_FOUND",
              `No dialog for ${sourceId}; pass up_to_message_id explicitly.`,
            );
          }

          const entity = await resolveEntity(client, sourceId);
          const request =
            entity.className === "Channel"
              ? new Api.channels.ReadHistory({
                  channel: entity as never,
                  maxId,
                })
              : new Api.messages.ReadHistory({ peer: entity as never, maxId });
          await client.invoke(request);

          return { source_id: sourceId, read_inbox_max_id: maxId };
        } catch (err) {
          const mapped = mapTelegramError(err);
          return {
            source_id: sourceId,
            code: mapped.code,
            message: mapped.message,
          };
        }
      },
    );
  });

  return {
    results: outcomes.filter(
      (outcome): outcome is MarkReadSuccess => "read_inbox_max_id" in outcome,
    ),
    failures: outcomes.filter(
      (outcome): outcome is MarkReadFailure => "code" in outcome,
    ),
  };
}

export type MarkUnreadInput = {
  source_ids: string[];
  unread: boolean;
};

export type MarkUnreadSuccess = {
  source_id: string;
  unread_mark: boolean;
};

export type MarkUnreadFailure = {
  source_id: string;
  code: string;
  message: string;
};

export type MarkUnreadResult = {
  results: MarkUnreadSuccess[];
  failures: MarkUnreadFailure[];
};

/**
 * Sets or clears Telegram's manual "come back to this" flag
 * (`Dialog.unreadMark`), which is independent of the unread COUNT: it does not
 * rewind the read pointer and clearing it marks nothing read. The read half
 * that makes it visible is in dialogs.ts and unread.ts.
 *
 * `unread:flags.0?true` is a conditional-true TL flag, so `unread: false` is
 * how the flag is cleared; teleproto omits the bit rather than sending false.
 */
export async function markUnread(
  input: MarkUnreadInput,
): Promise<MarkUnreadResult> {
  assertSourceIdsBounded(
    input.source_ids,
    "mark_unread",
    MAX_MARK_READ_SOURCES,
  );

  const outcomes = await withTelegram(async (client) => {
    const Api = await getApi();
    return mapWithConcurrency(
      input.source_ids,
      FANOUT_CONCURRENCY,
      async (sourceId): Promise<MarkUnreadSuccess | MarkUnreadFailure> => {
        try {
          const entity = await resolveEntity(client, sourceId);
          const peer = await toInputPeer(entity);
          await client.invoke(
            new Api.messages.MarkDialogUnread({
              unread: input.unread,
              peer: new Api.InputDialogPeer({ peer: peer as never }) as never,
            }),
          );
          return { source_id: sourceId, unread_mark: input.unread };
        } catch (err) {
          const mapped = mapTelegramError(err);
          return {
            source_id: sourceId,
            code: mapped.code,
            message: mapped.message,
          };
        }
      },
    );
  });

  return {
    results: outcomes.filter(
      (outcome): outcome is MarkUnreadSuccess => "unread_mark" in outcome,
    ),
    failures: outcomes.filter(
      (outcome): outcome is MarkUnreadFailure => "code" in outcome,
    ),
  };
}
