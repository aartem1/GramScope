import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { joinChannel } from "../../telegram/subscriptions";
import { telegramSourceSchema } from "../../schemas/source";
import { runTool } from "../tool-result";

export function registerJoinChannel(server: McpServer): void {
  server.registerTool(
    "join_channel",
    {
      title: "Join a Telegram channel",
      description:
        "Subscribe the account to one public channel or group, named by @username or t.me link. This CHANGES ACCOUNT STATE: the source starts appearing in list_dialogs and in unread sweeps. A channel the account already follows returns already_member true and changes nothing. Invite links (t.me/+hash) are not supported.",
      inputSchema: z.object({
        source: z
          .string()
          .describe(
            "One @username or t.me link. A bare numeric id resolves only for chats the account already belongs to, so it cannot name something to join.",
          ),
      }),
      outputSchema: z.object({
        source: telegramSourceSchema,
        already_member: z.boolean(),
      }),
      annotations: { readOnlyHint: false },
    },
    async (input) => runTool("join_channel", () => joinChannel(input)),
  );
}
