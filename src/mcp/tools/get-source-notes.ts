import type { McpServer } from "@modelcontextprotocol/server";
import { MAX_SOURCES_PER_CALL } from "../../limits";
import {
  getSourceNotesInputSchema,
  getSourceNotesOutputSchema,
  listSourceNotes,
} from "../../ops";
import { runTool } from "../tool-result";

export function registerGetSourceNotes(server: McpServer): void {
  server.registerTool(
    "get_source_notes",
    {
      title: "Read what GramScope knows about its sources",
      description:
        "Return source routing notes. about, topics, kind, lang, cadence and derived_from are GramScope assessments based on posts read; id, handle and title are third-party Telegram metadata copied from the resolved source. " +
        "Call with NO arguments to get the whole set — that is the intended use before deciding which sources to read for a question, and the set is small enough to read in one go. source_ids is a distinct, non-paged mode: it returns only the named sources, at most " +
        `${MAX_SOURCES_PER_CALL}, and clients must omit query, limit and cursor. Otherwise query searches the note text; for whole-store and query pages, limit is 1..200 and cursor continues the same mode.`,
      inputSchema: getSourceNotesInputSchema,
      outputSchema: getSourceNotesOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => runTool("get_source_notes", () => listSourceNotes(input)),
  );
}
