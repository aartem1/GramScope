import { sourceNoteSchema, type SourceNote } from "../schemas/source-note";
import { withTelegram, type TelegramLike } from "./client";
import {
  assertSameScope,
  decodeSourceNotesCursor,
  encodeSourceNotesCursor,
  scopeFingerprint,
} from "../pagination";
import {
  assertSourceIdsBounded,
  MAX_SOURCES_PER_CALL,
} from "./source-selection";

const MARKER_PREFIX = "gs:src:";

/**
 * The lookup key for one source's note.
 *
 * The leading minus of a marked id is dropped because it is punctuation to
 * Telegram's search tokenizer, and search is how a note is found: there is no
 * index message and a message id is not a durable handle (a probe on
 * 2026-08-29 read a deleted id and got a different object back). The signed id
 * survives inside the JSON, where it is the field every other tool joins on.
 */
export function noteMarker(sourceId: string): string {
  return `${MARKER_PREFIX}${sourceId.replace(/^-/, "")}`;
}

export type ParseOutcome =
  | { kind: "note"; note: SourceNote }
  | { kind: "other" }
  | { kind: "malformed"; reason: string };

export function serializeNote(note: SourceNote): string {
  return `${noteMarker(note.id)}\n${JSON.stringify(note)}`;
}

/**
 * Three outcomes, not two. `other` is a message that is not ours at all — the
 * `me` peer holds service messages, including one this account cannot delete —
 * and it is silently skipped. `malformed` is a message that claims to be a
 * note and is not, which is reported to the caller rather than skipped: a
 * corrupt note is a hole in the memory the agent should know about.
 *
 * A message is considered to claim ours if its first line starts with the
 * `gs:src:` prefix. If it does, any parsing errors are treated as corruption
 * (malformed) rather than a foreign message. This ensures that notes in older
 * wire format versions remain visible to the agent when the format changes.
 */
export function parseNoteMessage(text: string): ParseOutcome {
  const newline = text.indexOf("\n");
  const marker = newline === -1 ? text : text.slice(0, newline);

  if (!marker.startsWith("gs:src:")) {
    return { kind: "other" };
  }

  // The message claims to be ours. Any parsing failures are malformed notes.
  if (newline === -1) {
    return { kind: "malformed", reason: "marked line has no body" };
  }

  if (!/^\d+$/.test(marker.slice("gs:src:".length))) {
    return { kind: "malformed", reason: "marker suffix is not purely digits" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text.slice(newline + 1));
  } catch {
    return { kind: "malformed", reason: "body is not valid JSON" };
  }

  const parsed = sourceNoteSchema.safeParse(payload);
  if (!parsed.success) {
    return { kind: "malformed", reason: "body is not a source note" };
  }
  if (noteMarker(parsed.data.id) !== marker) {
    return {
      kind: "malformed",
      reason: "marker and note id disagree",
    };
  }
  return { kind: "note", note: parsed.data };
}

export const SAVED_PEER = "me";
export const DEFAULT_NOTES_LIMIT = 100;

export type GetSourceNotesInput = {
  source_ids?: string[];
  query?: string;
  limit?: number;
  cursor?: string;
};

export type GetSourceNotesResult = {
  notes: SourceNote[];
  duplicates: Array<{ source_id: string; message_ids: number[] }>;
  malformed: Array<{ message_id: number; reason: string }>;
  next_cursor?: string;
};

type RawMessage = { id: number; message?: unknown };

function textOf(message: RawMessage): string | undefined {
  return typeof message.message === "string" ? message.message : undefined;
}

async function fetchPage(
  client: TelegramLike,
  params: { limit: number; offsetId?: number; search?: string },
): Promise<RawMessage[]> {
  const page = (await client.getMessages(SAVED_PEER, {
    limit: params.limit,
    ...(params.offsetId ? { offsetId: params.offsetId } : {}),
    ...(params.search ? { search: params.search } : {}),
  })) as RawMessage[];
  // teleproto returns a TotalList, an Array subclass that survives map and
  // filter. Normalize before the value goes anywhere near a domain result.
  return Array.from(page);
}

/**
 * Collapses a page of raw messages into notes, duplicates and malformed
 * entries. Newest wins a duplicate: an interrupted delete-and-resend leaves
 * the older copy behind, and the newer one is what the last write intended.
 */
function collect(messages: RawMessage[]): {
  notes: SourceNote[];
  duplicates: GetSourceNotesResult["duplicates"];
  malformed: GetSourceNotesResult["malformed"];
} {
  const byId = new Map<string, { note: SourceNote; ids: number[] }>();
  const malformed: GetSourceNotesResult["malformed"] = [];

  for (const message of [...messages].sort((a, b) => b.id - a.id)) {
    const text = textOf(message);
    if (text === undefined) continue;
    const outcome = parseNoteMessage(text);
    if (outcome.kind === "other") continue;
    if (outcome.kind === "malformed") {
      malformed.push({ message_id: message.id, reason: outcome.reason });
      continue;
    }
    const seen = byId.get(outcome.note.id);
    if (seen) seen.ids.push(message.id);
    else byId.set(outcome.note.id, { note: outcome.note, ids: [message.id] });
  }

  const duplicates: GetSourceNotesResult["duplicates"] = [];
  for (const [sourceId, entry] of byId) {
    if (entry.ids.length > 1) {
      duplicates.push({ source_id: sourceId, message_ids: entry.ids });
    }
  }

  return {
    notes: [...byId.values()].map((entry) => entry.note),
    duplicates,
    malformed,
  };
}

export type FoundNotes = {
  notes: Array<{ id: number; note: SourceNote }>;
  malformed: Array<{ message_id: number; reason: string }>;
};

/** Every message carrying one source's marker, newest first. The marker
 *  narrows; the parse decides, because Telegram matches word prefixes and a
 *  longer id starts with a shorter one.
 *
 * A malformed hit is attributed to this source only when its first line is
 * `noteMarker(sourceId)` exactly: the body is corrupt, so the id inside it
 * cannot be trusted, and the marker search matches word prefixes, so a
 * malformed message belonging to a different, longer source id must not be
 * blamed on this one. A malformed hit under a different marker is left for
 * the general scan to report. */
export async function findNoteMessages(
  client: TelegramLike,
  sourceId: string,
): Promise<FoundNotes> {
  const marker = noteMarker(sourceId);
  const page = await fetchPage(client, { limit: 20, search: marker });
  const notes: FoundNotes["notes"] = [];
  const malformed: FoundNotes["malformed"] = [];
  for (const message of page) {
    const text = textOf(message);
    if (text === undefined) continue;
    const outcome = parseNoteMessage(text);
    if (outcome.kind === "note" && outcome.note.id === sourceId) {
      notes.push({ id: message.id, note: outcome.note });
    } else if (outcome.kind === "malformed") {
      const newline = text.indexOf("\n");
      const firstLine = newline === -1 ? text : text.slice(0, newline);
      if (firstLine === marker) {
        malformed.push({ message_id: message.id, reason: outcome.reason });
      }
    }
  }
  return {
    notes: notes.sort((a, b) => b.id - a.id),
    malformed,
  };
}

export async function listSourceNotes(
  input: GetSourceNotesInput,
): Promise<GetSourceNotesResult> {
  if (input.source_ids) {
    assertSourceIdsBounded(
      input.source_ids,
      "get_source_notes",
      MAX_SOURCES_PER_CALL,
    );
  }

  return withTelegram(async (client) => {
    if (input.source_ids) {
      const notes: SourceNote[] = [];
      const duplicates: GetSourceNotesResult["duplicates"] = [];
      const malformed: GetSourceNotesResult["malformed"] = [];
      for (const sourceId of input.source_ids) {
        const found = await findNoteMessages(client, sourceId);
        malformed.push(...found.malformed);
        if (found.notes.length === 0) continue;
        notes.push(found.notes[0]!.note);
        if (found.notes.length > 1) {
          duplicates.push({
            source_id: sourceId,
            message_ids: found.notes.map((entry) => entry.id),
          });
        }
      }
      return { notes, duplicates, malformed };
    }

    const fingerprint = scopeFingerprint({ query: input.query });
    let offsetId = 0;
    if (input.cursor) {
      const cursor = decodeSourceNotesCursor(input.cursor);
      assertSameScope(cursor.fingerprint, fingerprint);
      offsetId = cursor.offsetId;
    }

    const limit = input.limit ?? DEFAULT_NOTES_LIMIT;
    const page = await fetchPage(client, {
      limit,
      ...(offsetId ? { offsetId } : {}),
      ...(input.query ? { search: input.query } : {}),
    });
    const collected = collect(page);
    const oldest = page.reduce(
      (min, message) => (min === 0 || message.id < min ? message.id : min),
      0,
    );

    return {
      ...collected,
      ...(page.length === limit && oldest > 0
        ? {
            next_cursor: encodeSourceNotesCursor({
              offsetId: oldest,
              fingerprint,
            }),
          }
        : {}),
    };
  });
}
