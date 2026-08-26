import type { McpServer } from "@modelcontextprotocol/server";
import { registerGetChannel } from "./tools/get-channel";
import { registerListDialogs } from "./tools/list-dialogs";
import { registerListFolders } from "./tools/list-folders";

export function registerTools(server: McpServer): void {
  registerListDialogs(server);
  registerListFolders(server);
  registerGetChannel(server);
}
