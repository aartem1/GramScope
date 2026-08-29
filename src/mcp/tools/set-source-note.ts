import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { deleteSourceNote, setSourceNote } from "../../telegram/source-notes";
import {
  MAX_ABOUT_CHARS,
  MAX_CADENCE_CHARS,
  MAX_DERIVED_FROM_CHARS,
  MAX_LANG_CHARS,
  MAX_TOPIC_CHARS,
  MAX_TOPICS,
  NOTE_KINDS,
  sourceNoteSchema,
} from "../../schemas/source-note";
import { GramScopeError } from "../../errors/taxonomy";
import { runTool } from "../tool-result";

export function registerSetSourceNote(server: McpServer): void {
  server.registerTool(
    "set_source_note",
    {
      title: "Record what this source is",
      description:
        "Write or delete the single note this server keeps about one source. This CHANGES ACCOUNT STATE. Setting replaces that source's previous note; there is one note per source and no history. " +
        `about is at most ${MAX_ABOUT_CHARS} characters; topics at most ${MAX_TOPICS} entries; each topic at most ${MAX_TOPIC_CHARS} characters; lang at most ${MAX_LANG_CHARS} characters; cadence at most ${MAX_CADENCE_CHARS} characters; derived_from at most ${MAX_DERIVED_FROM_CHARS} characters. These limits keep the store small enough to read whole. ` +
        "Write about, topics and kind from posts actually read: a channel's name and its own description are claims it makes about itself, not observations of what it publishes. id, handle and title are filled from the resolved source and cannot be supplied.",
      inputSchema: z.object({
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
      }),
      outputSchema: z.object({
        note: sourceNoteSchema.optional(),
        replaced: z.boolean().optional(),
        deleted: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: false },
    },
    async (input) =>
      runTool("set_source_note", async () => {
        if (input.action === "delete") {
          return deleteSourceNote(input.source_id);
        }
        if (!input.about || !input.topics || !input.kind) {
          throw new GramScopeError(
            "INVALID_INPUT",
            "action 'set' requires about, topics and kind.",
          );
        }
        return setSourceNote({
          source_id: input.source_id,
          about: input.about,
          topics: input.topics,
          kind: input.kind,
          ...(input.lang ? { lang: input.lang } : {}),
          ...(input.cadence ? { cadence: input.cadence } : {}),
          ...(input.derived_from ? { derived_from: input.derived_from } : {}),
        });
      }),
  );
}
