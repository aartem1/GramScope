import { getApi, withTelegram } from "./client";
import { fetchDialogIndex } from "./dialog-index";
import { resolveSource } from "./peer-resolve";
import { readMessagesPage } from "./tl-messages";
import {
  assertSameScope,
  decodePinnedCursor,
  encodePinnedCursor,
  scopeFingerprint,
} from "../pagination";
import { fitToSizeCap } from "../schemas/size";
import {
  mapMessage,
  type MessageContext,
  type TelegramMessage,
} from "../schemas/message";

export type GetPinnedInput = {
  source_id: string;
  limit: number;
  cursor?: string;
};

export type GetPinnedResult = {
  source_id: string;
  source_title: string;
  messages: TelegramMessage[];
  next_cursor?: string;
};

export async function getPinnedMessages(
  input: GetPinnedInput,
): Promise<GetPinnedResult> {
  const index = await fetchDialogIndex();

  return withTelegram(async (client) => {
    const source = await resolveSource(client, index, input.source_id);
    const fingerprint = scopeFingerprint({ source: source.source_id });
    const cursor = input.cursor ? decodePinnedCursor(input.cursor) : undefined;
    if (cursor) assertSameScope(cursor.fingerprint, fingerprint);

    const Api = await getApi();
    // messages.getHistory cannot filter, so the pinned tab is a search with an
    // empty query — the same primitive the Telegram app uses.
    const page = readMessagesPage(
      await client.invoke(
        new Api.messages.Search({
          peer: source.handle as never,
          q: "",
          filter: new Api.InputMessagesFilterPinned() as never,
          minDate: 0,
          maxDate: 0,
          offsetId: cursor?.offsetId ?? 0,
          addOffset: 0,
          limit: input.limit,
          maxId: 0,
          minId: 0,
          hash: 0 as never,
        }),
      ),
    );

    const entry = index.byId.get(source.source_id);
    const context: MessageContext = {
      chatId: source.source_id,
      ...(source.username !== undefined ? { username: source.username } : {}),
      ...(entry !== undefined
        ? { readInboxMaxId: entry.read_inbox_max_id }
        : {}),
    };

    const base = {
      source_id: source.source_id,
      source_title: source.title,
    };
    const all = page.messages.map((raw) => mapMessage(raw, context));

    const assemble = (messages: TelegramMessage[]): GetPinnedResult => {
      const exhausted =
        messages.length === all.length && all.length < input.limit;
      const oldest = messages[messages.length - 1];

      return {
        ...base,
        messages,
        ...(exhausted || oldest === undefined
          ? {}
          : {
              next_cursor: encodePinnedCursor({
                offsetId: oldest.id,
                fingerprint,
              }),
            }),
      };
    };

    const fit = fitToSizeCap(all, assemble);
    return assemble(all.slice(0, fit));
  });
}
