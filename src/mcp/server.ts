import type { McpServer } from "@modelcontextprotocol/server";
import { registerGetChannel } from "./tools/get-channel";
import { registerGetMessage } from "./tools/get-message";
import { registerGetMessages } from "./tools/get-messages";
import { registerGetUnreadSummary } from "./tools/get-unread-summary";
import { registerListDialogs } from "./tools/list-dialogs";
import { registerListFolders } from "./tools/list-folders";
import { registerMarkRead } from "./tools/mark-read";

export function registerTools(server: McpServer): void {
  registerListDialogs(server);
  registerListFolders(server);
  registerGetChannel(server);
  registerGetMessages(server);
  registerGetMessage(server);
  registerGetUnreadSummary(server);
  registerMarkRead(server);
}
