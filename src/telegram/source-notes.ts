import { sourceNoteSchema, type SourceNote } from "../schemas/source-note";

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
 */
export function parseNoteMessage(text: string): ParseOutcome {
  const newline = text.indexOf("\n");
  if (newline === -1) return { kind: "other" };
  const marker = text.slice(0, newline);
  if (!/^gs:src:\d+$/.test(marker)) return { kind: "other" };

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
