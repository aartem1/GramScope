import type { McpServer } from "@modelcontextprotocol/server";
import {
  joinChannel,
  joinChannelInputSchema,
  joinChannelOutputSchema,
} from "../../ops";
import { runTool } from "../tool-result";

export function registerJoinChannel(server: McpServer): void {
  server.registerTool(
    "join_channel",
    {
      title: "Join a Telegram channel",
      description:
        "Subscribe the account to one public channel or group, named by @username or t.me link. This CHANGES ACCOUNT STATE: the source starts appearing in list_dialogs and in unread sweeps. A channel the account already follows returns already_member true and changes nothing. Invite links (t.me/+hash) are not supported.",
      inputSchema: joinChannelInputSchema,
      outputSchema: joinChannelOutputSchema,
      annotations: { readOnlyHint: false },
    },
    async (input) => runTool("join_channel", () => joinChannel(input)),
  );
}
