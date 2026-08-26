import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { getChannel } from "../../telegram/dialogs";
import { telegramSourceSchema } from "../../schemas/source";
import { errorResult, okResult } from "../tool-result";

export function registerGetChannel(server: McpServer): void {
  server.registerTool(
    "get_channel",
    {
      title: "Get a Telegram source",
      description:
        "Get details for one channel, group or chat by numeric id, @username, or t.me URL. Provide exactly one identifier. Read-only.",
      inputSchema: z.object({
        id: z.string().optional(),
        username: z.string().optional(),
        url: z.string().optional(),
      }),
      outputSchema: telegramSourceSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      try {
        return okResult(await getChannel(input));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
