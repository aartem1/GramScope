import type { McpServer } from "@modelcontextprotocol/server";
import {
  getMessage,
  getMessageInputSchema,
  getMessageOutputSchema,
} from "../../ops";
import { runTool } from "../tool-result";

export function registerGetMessage(server: McpServer): void {
  server.registerTool(
    "get_message",
    {
      title: "Read one Telegram message",
      description:
        "Read a single message by source id and message id, optionally with the messages immediately before and after it. Context arrays are in ascending date order; missing context is a shorter array, not an error. Read-only.",
      inputSchema: getMessageInputSchema,
      outputSchema: getMessageOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => runTool("get_message", () => getMessage(input)),
  );
}
