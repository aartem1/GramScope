import { withTelegram } from "./client";
import {
  fetchDialogIndex,
  folderMembers,
  type DialogIndex,
} from "./dialog-index";
import { fetchSlice, type MediaType, type Slice } from "./message-slice";
import { FANOUT_CONCURRENCY, mapWithConcurrency } from "../concurrency";
import { decodeMessageCursor, encodeMessageCursor } from "../pagination";
import { fitToSizeCap, MAX_RESPONSE_BYTES } from "../schemas/size";
import { GramScopeError } from "../errors/taxonomy";
import { mapTelegramError } from "../errors/from-telegram";
import {
  mapMessage,
  type MessageContext,
  type TelegramMessage,
} from "../schemas/message";

/**
 * Spec §5.1. A fan-out wider than this stops being one tool call and starts
 * being a job: 25 sources at limit 100 already fetches 2500 messages.
 */
export const MAX_SOURCES_PER_CALL = 25;

export type GetMessagesInput = {
  source_ids?: string[];
  folder_ids?: string[];
  exclude_source_ids?: string[];
  from?: string;
  to?: string;
  unread_only?: boolean;
  media_type?: MediaType;
  limit: number;
  cursor?: string;
};

export type SourceBlock = {
  source_id: string;
  title: string;
  messages?: TelegramMessage[];
  has_more?: boolean;
  error?: { code: string; message: string };
};

export type GetMessagesResult = {
  sources: SourceBlock[];
  next_cursor?: string;
};

export function parseDateBound(
  value: string | undefined,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new GramScopeError(
      "INVALID_INPUT",
      `${field} is not an ISO 8601 date`,
    );
  }
  return Math.floor(ms / 1000);
}

/**
 * A cursor carries its own source set, so a continuation never re-derives one
 * from folder membership that may have changed between pages.
 */
export function resolveSourceSet(
  input: GetMessagesInput,
  index: DialogIndex,
): Array<{ sourceId: string; offsetId: number }> {
  let resolved: Array<{ sourceId: string; offsetId: number }>;
  if (input.cursor) {
    resolved = decodeMessageCursor(input.cursor).sources;
  } else {
    const excluded = new Set(input.exclude_source_ids ?? []);
    const seen = new Set<string>();
    const ordered: string[] = [];

    for (const id of [
      ...(input.source_ids ?? []),
      ...folderMembers(index.folders, input.folder_ids ?? []),
    ]) {
      if (excluded.has(id) || seen.has(id)) continue;
      seen.add(id);
      ordered.push(id);
    }
    resolved = ordered.map((sourceId) => ({ sourceId, offsetId: 0 }));
  }

  if (resolved.length === 0) {
    throw new GramScopeError(
      "INVALID_INPUT",
      "Name at least one source: pass source_ids, folder_ids, or a cursor from a previous page.",
    );
  }
  if (resolved.length > MAX_SOURCES_PER_CALL) {
    throw new GramScopeError(
      "INVALID_INPUT",
      `This selection resolves to ${resolved.length} sources; the limit is ${MAX_SOURCES_PER_CALL}. Split the call.`,
    );
  }

  return resolved;
}

export type Fetched = {
  source_id: string;
  title: string;
  /** Where this page started reading; the resume point if it served nothing. */
  startOffsetId: number;
  slice?: Slice;
  error?: { code: string; message: string };
};

type Unit = { blockIndex: number; message: TelegramMessage };

function compose(
  fetched: Fetched[],
  kept: Unit[],
  oversized?: Unit,
): GetMessagesResult {
  const keptCount = new Array<number>(fetched.length).fill(0);
  for (const unit of kept) keptCount[unit.blockIndex]!++;

  const sources: SourceBlock[] = [];
  const unexhausted: Array<{ sourceId: string; offsetId: number }> = [];
  let stopped = false;

  for (let i = 0; i < fetched.length; i++) {
    const block = fetched[i]!;

    // A failing source is always visible and never cursored: retrying it on
    // the next page would only reproduce the failure.
    if (block.error) {
      sources.push({
        source_id: block.source_id,
        title: block.title,
        error: block.error,
      });
      continue;
    }

    if (oversized?.blockIndex === i) {
      sources.push({
        source_id: block.source_id,
        title: block.title,
        error: {
          code: "INTERNAL_ERROR",
          message: `Message ${oversized.message.id} exceeds the 256 KB response limit and was skipped without truncation.`,
        },
      });
      const all = block.slice?.messages ?? [];
      if (all.length > 1 || block.slice?.hasMore) {
        unexhausted.push({
          sourceId: block.source_id,
          offsetId: oversized.message.id,
        });
      }
      stopped = true;
      continue;
    }

    if (stopped) {
      unexhausted.push({
        sourceId: block.source_id,
        offsetId: block.startOffsetId,
      });
      continue;
    }

    const all = block.slice?.messages ?? [];
    const n = keptCount[i]!;

    if (n === all.length) {
      sources.push({
        source_id: block.source_id,
        title: block.title,
        messages: all,
        has_more: block.slice?.hasMore ?? false,
      });
      if (block.slice?.hasMore) {
        unexhausted.push({
          sourceId: block.source_id,
          offsetId: block.slice.nextOffsetId,
        });
      }
      continue;
    }

    // The budget ran out inside this block. Nothing after it is served, and
    // a block with zero kept messages is omitted entirely — the caller must
    // be able to tell "nothing new here" from "ask again".
    stopped = true;
    if (n === 0) {
      unexhausted.push({
        sourceId: block.source_id,
        offsetId: block.startOffsetId,
      });
      continue;
    }
    const trimmed = all.slice(0, n);
    sources.push({
      source_id: block.source_id,
      title: block.title,
      messages: trimmed,
      has_more: true,
    });
    unexhausted.push({
      sourceId: block.source_id,
      offsetId: trimmed[trimmed.length - 1]!.id,
    });
  }

  return {
    sources,
    ...(unexhausted.length > 0
      ? { next_cursor: encodeMessageCursor({ sources: unexhausted }) }
      : {}),
  };
}

/**
 * Assembles the page source by source, in the requested order, while it fits
 * the response cap. Flattening to one unit per message lets fitToSizeCap search
 * leading units in order. If even the first complete result is too large, the
 * message is skipped visibly and the cursor resumes after its id.
 */
export function renderPage(fetched: Fetched[]): GetMessagesResult {
  const units: Unit[] = fetched.flatMap((block, blockIndex) =>
    (block.slice?.messages ?? []).map((message) => ({ blockIndex, message })),
  );
  const fit = fitToSizeCap(units, (kept) => compose(fetched, kept));
  const page = compose(fetched, units.slice(0, fit));
  if (
    Buffer.byteLength(JSON.stringify(page), "utf8") <= MAX_RESPONSE_BYTES ||
    units.length === 0
  ) {
    return page;
  }

  return compose(fetched, [], units[0]);
}

export async function getMessages(
  input: GetMessagesInput,
): Promise<GetMessagesResult> {
  const fromSeconds = parseDateBound(input.from, "from");
  const toSeconds = parseDateBound(input.to, "to");
  if (
    fromSeconds !== undefined &&
    toSeconds !== undefined &&
    fromSeconds > toSeconds
  ) {
    throw new GramScopeError("INVALID_DATE_RANGE", "from is after to");
  }

  const index = await fetchDialogIndex();
  const targets = resolveSourceSet(input, index);

  const fetched = await withTelegram(async (client) =>
    mapWithConcurrency(targets, FANOUT_CONCURRENCY, async (target) => {
      const entry = index.byId.get(target.sourceId);
      const title = entry?.title ?? target.sourceId;
      try {
        const slice = await fetchSlice(client, {
          sourceId: target.sourceId,
          ...(entry?.username !== undefined
            ? { username: entry.username }
            : {}),
          ...(entry !== undefined
            ? { readInboxMaxId: entry.read_inbox_max_id }
            : {}),
          limit: input.limit,
          offsetId: target.offsetId,
          ...(fromSeconds !== undefined ? { fromSeconds } : {}),
          ...(toSeconds !== undefined ? { toSeconds } : {}),
          ...(input.unread_only === true ? { unreadOnly: true } : {}),
          ...(input.media_type !== undefined
            ? { mediaType: input.media_type }
            : {}),
        });
        return {
          source_id: target.sourceId,
          title,
          startOffsetId: target.offsetId,
          slice,
        } satisfies Fetched;
      } catch (err) {
        // Spec §11: one dead channel must not cost a digest.
        const mapped = mapTelegramError(err);
        return {
          source_id: target.sourceId,
          title,
          startOffsetId: target.offsetId,
          error: { code: mapped.code, message: mapped.message },
        } satisfies Fetched;
      }
    }),
  );

  return renderPage(fetched);
}

export const MAX_CONTEXT = 20;

export type GetMessageInput = {
  source_id: string;
  message_id: number;
  context_before?: number;
  context_after?: number;
};

export type GetMessageResult = {
  source_id: string;
  source_title: string;
  message: TelegramMessage;
  context_before: TelegramMessage[];
  context_after: TelegramMessage[];
};

function inBounds(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MAX_CONTEXT;
}

export async function getMessage(
  input: GetMessageInput,
): Promise<GetMessageResult> {
  const before = input.context_before ?? 0;
  const after = input.context_after ?? 0;
  if (!inBounds(before) || !inBounds(after)) {
    throw new GramScopeError(
      "INVALID_INPUT",
      `context_before and context_after must be whole numbers between 0 and ${MAX_CONTEXT}`,
    );
  }

  const index = await fetchDialogIndex();
  const entry = index.byId.get(input.source_id);
  const ctx: MessageContext = {
    chatId: input.source_id,
    ...(entry?.username !== undefined ? { username: entry.username } : {}),
    ...(entry !== undefined ? { readInboxMaxId: entry.read_inbox_max_id } : {}),
  };

  return withTelegram(async (client) => {
    const found = await client.getMessages(input.source_id, {
      ids: [input.message_id],
    });
    const target = (found[0] ?? undefined) as Record<string, unknown> | undefined;
    if (!target || typeof target.id !== "number") {
      throw new GramScopeError(
        "MESSAGE_NOT_FOUND",
        `No message ${input.message_id} in ${input.source_id}`,
      );
    }

    // Telegram returns history newest-first from an offset. Older context is
    // a plain page from the target; newer context is the same page shifted
    // backwards past it, which is what a negative add_offset means.
    const older =
      before > 0
        ? await client.getMessages(input.source_id, {
            limit: before,
            offsetId: input.message_id,
          })
        : [];
    const newer =
      after > 0
        ? await client.getMessages(input.source_id, {
            limit: after,
            offsetId: input.message_id,
            addOffset: -after,
          })
        : [];

    const toAscending = (raw: unknown[]) =>
      raw
        .filter(
          (item): item is Record<string, unknown> =>
            typeof item === "object" &&
            item !== null &&
            typeof (item as Record<string, unknown>).id === "number",
        )
        .map((item) => mapMessage(item, ctx))
        .sort((a, b) => a.id - b.id);

    return {
      source_id: input.source_id,
      source_title: entry?.title ?? input.source_id,
      message: mapMessage(target, ctx),
      context_before: toAscending(older),
      context_after: toAscending(newer),
    };
  });
}
