import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { leaveChannel } from "../../telegram/subscriptions";
import { telegramSourceSchema } from "../../schemas/source";
import { runTool } from "../tool-result";

export function registerLeaveChannel(server: McpServer): void {
  server.registerTool(
    "leave_channel",
    {
      title: "Leave a Telegram channel",
      description:
        "Unsubscribe the account from ONE channel or group. This CHANGES ACCOUNT STATE and takes exactly one source per call. A private channel cannot be re-joined afterwards without a new invite, so leaving one is irreversible. A source the account does not belong to returns was_member false and changes nothing. The response echoes the source as it was before leaving.",
      inputSchema: z.object({
        source: z
          .string()
          .describe("One source: numeric id, @username, or t.me link."),
      }),
      outputSchema: z.object({
        source: telegramSourceSchema,
        was_member: z.boolean(),
      }),
      annotations: { readOnlyHint: false },
    },
    async (input) => runTool("leave_channel", () => leaveChannel(input)),
  );
}
