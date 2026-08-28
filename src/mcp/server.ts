import type { McpServer } from "@modelcontextprotocol/server";
import { registerGetChannel } from "./tools/get-channel";
import { registerGetMessage } from "./tools/get-message";
import { registerGetMessages } from "./tools/get-messages";
import { registerGetPinnedMessages } from "./tools/get-pinned-messages";
import { registerGetSimilarChannels } from "./tools/get-similar-channels";
import { registerGetThread } from "./tools/get-thread";
import { registerGetUnreadSummary } from "./tools/get-unread-summary";
import { registerListDialogs } from "./tools/list-dialogs";
import { registerListFolders } from "./tools/list-folders";
import { registerMarkRead } from "./tools/mark-read";
import { registerResolveTelegramUrl } from "./tools/resolve-telegram-url";
import { registerSearchMessages } from "./tools/search-messages";
import { registerSearchChannels } from "./tools/search-channels";

export function registerTools(server: McpServer): void {
  registerListDialogs(server);
  registerListFolders(server);
  registerGetChannel(server);
  registerGetMessages(server);
  registerGetMessage(server);
  registerGetThread(server);
  registerGetUnreadSummary(server);
  registerMarkRead(server);
  registerSearchMessages(server);
  registerResolveTelegramUrl(server);
  registerGetPinnedMessages(server);
  registerSearchChannels(server);
  registerGetSimilarChannels(server);
}
