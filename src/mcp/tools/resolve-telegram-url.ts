import type { McpServer } from "@modelcontextprotocol/server";
import {
  resolveTelegramUrl,
  resolveTelegramUrlInputSchema,
  resolveTelegramUrlOutputSchema,
} from "../../ops";
import { runTool } from "../tool-result";

export function registerResolveTelegramUrl(server: McpServer): void {
  server.registerTool(
    "resolve_telegram_url",
    {
      title: "Resolve a Telegram link",
      description:
        "Turn a Telegram link, @username or bare name into something the other tools can call. Accepts t.me/name, t.me/name/123, t.me/name/123?comment=456, t.me/c/<id>/<msg>, t.me/+hash and t.me/joinchat/hash. kind says what the link points at: a source, a specific post, or an invite. joined says whether the account is a member; it does not have to be for get_messages, get_thread or search_messages to read a public channel. An invite preview has no source_id and cannot be read; joining is not supported. A t.me/c/ link resolves only for chats the account is already in. This tool never joins anything and changes nothing.",
      inputSchema: resolveTelegramUrlInputSchema,
      outputSchema: resolveTelegramUrlOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      runTool("resolve_telegram_url", () => resolveTelegramUrl(input)),
  );
}
