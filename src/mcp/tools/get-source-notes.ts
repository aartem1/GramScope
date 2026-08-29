import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { listSourceNotes } from "../../telegram/source-notes";
import { MAX_SOURCES_PER_CALL } from "../../telegram/source-selection";
import { sourceNoteSchema } from "../../schemas/source-note";
import { runTool } from "../tool-result";

export function registerGetSourceNotes(server: McpServer): void {
  server.registerTool(
    "get_source_notes",
    {
      title: "Read what GramScope knows about its sources",
      description:
        "Return GramScope's own notes about sources: what each source publishes, its topics, and what kind of source it is. Call with NO arguments to get the whole set — that is the intended use before deciding which sources to read for a question, and the set is small enough to read in one go. source_ids returns only the sources named, at most " +
        `${MAX_SOURCES_PER_CALL} of them, and never pages. query searches the note text. These notes were written by set_source_note; they are this server's own assessments, not text taken from Telegram.`,
      inputSchema: z.object({
        source_ids: z.array(z.string()).max(MAX_SOURCES_PER_CALL).optional(),
        query: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().optional(),
      }),
      outputSchema: z.object({
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
      }),
      annotations: { readOnlyHint: true },
    },
    async (input) => runTool("get_source_notes", () => listSourceNotes(input)),
  );
}
