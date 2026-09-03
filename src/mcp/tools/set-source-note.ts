import type { McpServer } from "@modelcontextprotocol/server";
import {
  MAX_ABOUT_CHARS,
  MAX_CADENCE_CHARS,
  MAX_DERIVED_FROM_CHARS,
  MAX_LANG_CHARS,
  MAX_TOPIC_CHARS,
  MAX_TOPICS,
} from "../../schemas/source-note";
import {
  setSourceNote,
  setSourceNoteInputSchema,
  setSourceNoteOutputSchema,
} from "../../ops";
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
      inputSchema: setSourceNoteInputSchema,
      outputSchema: setSourceNoteOutputSchema,
      annotations: { readOnlyHint: false },
    },
    async (input) => runTool("set_source_note", () => setSourceNote(input)),
  );
}
