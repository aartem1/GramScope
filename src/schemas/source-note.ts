import { z } from "zod";
import { GramScopeError } from "../errors/taxonomy";

/**
 * What a source IS, epistemically — not what it covers. The field exists so a
 * later read can weigh the content: an aggregator's post is a pointer, an
 * opinion channel's post is its author's claim. Spec §5.
 */
export const NOTE_KINDS = [
  "reporting",
  "aggregator",
  "opinion",
  "promo",
  "mixed",
] as const;

export type NoteKind = (typeof NOTE_KINDS)[number];

export const MAX_ABOUT_CHARS = 300;
export const MAX_TOPICS = 12;
export const MAX_TOPIC_CHARS = 32;
export const MAX_LANG_CHARS = 16;
export const MAX_CADENCE_CHARS = 32;
export const MAX_DERIVED_FROM_CHARS = 60;

/**
 * A note as it is STORED and read back. Deliberately permissive about length:
 * a note written under an older cap is still a note, and a reader that
 * rejected it would destroy the memory it exists to serve. Input is guarded
 * separately, by assertNoteInputBounded.
 */
export const sourceNoteSchema = z.object({
  id: z.string(),
  handle: z.string().optional(),
  title: z.string(),
  about: z.string(),
  topics: z.array(z.string()),
  kind: z.enum(NOTE_KINDS),
  lang: z.string().optional(),
  cadence: z.string().optional(),
  derived_from: z.string().optional(),
  updated: z.string(),
});

export type SourceNote = z.infer<typeof sourceNoteSchema>;

/** The agent-supplied half. id, handle, title and updated are server-derived. */
export type SourceNoteInput = {
  about: string;
  topics: string[];
  kind: NoteKind;
  lang?: string;
  cadence?: string;
  derived_from?: string;
};

function assertLength(
  value: string | undefined,
  field: string,
  limit: number,
): void {
  if (value === undefined) return;
  if (value.length <= limit) return;
  throw new GramScopeError(
    "INVALID_INPUT",
    `${field} is ${value.length} characters; the limit is ${limit}. Shorten it.`,
  );
}

/**
 * The caps that keep the store compact. They are the owner's one binding
 * constraint on this feature — the memory must not become a dump — expressed
 * as a refusal rather than as advice, because advice in a tool description is
 * not enforcement.
 */
export function assertNoteInputBounded(input: SourceNoteInput): void {
  assertLength(input.about, "about", MAX_ABOUT_CHARS);
  assertLength(input.lang, "lang", MAX_LANG_CHARS);
  assertLength(input.cadence, "cadence", MAX_CADENCE_CHARS);
  assertLength(input.derived_from, "derived_from", MAX_DERIVED_FROM_CHARS);

  if (input.topics.length === 0) {
    throw new GramScopeError(
      "INVALID_INPUT",
      "topics must name at least one topic; it is what makes the note findable.",
    );
  }
  if (input.topics.length > MAX_TOPICS) {
    throw new GramScopeError(
      "INVALID_INPUT",
      `topics has ${input.topics.length} entries; the limit is ${MAX_TOPICS}. Keep the ones a question would actually be asked about.`,
    );
  }
  for (const topic of input.topics) {
    if (topic.trim().length === 0) {
      throw new GramScopeError(
        "INVALID_INPUT",
        "topics must not contain a blank entry",
      );
    }
    assertLength(topic, `topic ${JSON.stringify(topic)}`, MAX_TOPIC_CHARS);
  }
}
