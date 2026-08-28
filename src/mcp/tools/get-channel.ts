import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { getChannel } from "../../telegram/dialogs";
import { telegramSourceSchema } from "../../schemas/source";
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
      inputSchema: z.object({
        id: z
          .string()
          .optional()
          .describe(
            "Numeric peer id as returned by list_dialogs. Provide exactly one of id, username, or url.",
          ),
        username: z
          .string()
          .optional()
          .describe(
            "Public @username, with or without the @. Provide exactly one of id, username, or url.",
          ),
        url: z
          .string()
          .optional()
          .describe(
            "A t.me link, e.g. https://t.me/example. Provide exactly one of id, username, or url.",
          ),
      }),
      outputSchema: telegramSourceSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => runTool("get_channel", () => getChannel(input)),
  );
}
