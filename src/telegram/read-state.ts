import { FANOUT_CONCURRENCY, mapWithConcurrency } from "../concurrency";
import { mapTelegramError } from "../errors/from-telegram";
import { GramScopeError } from "../errors/taxonomy";
import { getApi, resolveEntity, withTelegram } from "./client";
import { fetchDialogIndex } from "./dialog-index";

export const MAX_MARK_READ_SOURCES = 25;

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
 * The only mutating path in this sub-project, kept in its own file so it can
 * be reviewed on its own.
 *
 * Peers resolve exactly as reads do. Task 1 verified live that Telegram
 * accepts channels.ReadHistory for channels resolved from marked ids.
 */
export async function markRead(
  input: MarkReadInput,
): Promise<MarkReadResult> {
  if (input.source_ids.length === 0) {
    throw new GramScopeError(
      "INVALID_INPUT",
      "source_ids must name at least one source",
    );
  }
  if (input.source_ids.length > MAX_MARK_READ_SOURCES) {
    throw new GramScopeError(
      "INVALID_INPUT",
      `mark_read accepts at most ${MAX_MARK_READ_SOURCES} sources per call; got ${input.source_ids.length}. Split the call.`,
    );
  }

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
