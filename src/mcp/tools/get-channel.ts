import type { McpServer } from "@modelcontextprotocol/server";
import {
  getChannel,
  getChannelInputSchema,
  getChannelOutputSchema,
} from "../../ops";
import { runTool } from "../tool-result";

export function registerGetChannel(server: McpServer): void {
  server.registerTool(
    "get_channel",
    {
      title: "Get a Telegram source",
      description:
        "Get details for one channel, group or chat by numeric id, @username, or t.me URL. Provide exactly one identifier. Read-only.",
      // The "exactly one" rule is enforced in getChannel, but a runtime-only
      // rule is invisible to the caller: it has to be in the JSON Schema
      // ChatGPT reads, or it is discovered by failing a call.
      inputSchema: getChannelInputSchema,
      outputSchema: getChannelOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => runTool("get_channel", () => getChannel(input)),
  );
}
