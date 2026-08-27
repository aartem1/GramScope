import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { resolveTelegramUrl } from "../../telegram/resolve";
import { runTool } from "../tool-result";
import { OUTSIDE_SOURCE_GUIDANCE } from "../source-guidance";

export function registerResolveTelegramUrl(server: McpServer): void {
  server.registerTool(
    "resolve_telegram_url",
    {
      title: "Resolve a Telegram link",
      description:
        `Turn a Telegram link, @username or bare name into something the other tools can call. Accepts t.me/name, t.me/name/123, t.me/name/123?comment=456, t.me/c/<id>/<msg>, t.me/+hash and t.me/joinchat/hash. kind says what the link points at: a source, a specific post, or an invite. joined says whether the account is a member; it does not have to be for get_messages, get_thread or search_messages to read a public channel. ${OUTSIDE_SOURCE_GUIDANCE} An invite preview has no source_id and cannot be read; joining is not supported. A t.me/c/ link resolves only for chats the account is already in. This tool never joins anything and changes nothing.`,
      inputSchema: z.object({
        url: z
          .string()
          .min(1)
          .describe("A t.me link, a @username, or a bare channel name."),
      }),
      outputSchema: z.object({
        kind: z.enum(["source", "post", "invite"]),
        source: z
          .object({
            source_id: z.string().optional(),
            title: z.string(),
            username: z.string().optional(),
            type: z.enum(["channel", "group", "chat"]),
            subscriber_count: z.number().int().optional(),
            linked_discussion_id: z.string().optional(),
            joined: z.boolean(),
            folder_ids: z.array(z.string()).optional(),
          })
          .optional(),
        message_id: z.number().int().optional(),
        comment_id: z.number().int().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      runTool("resolve_telegram_url", () => resolveTelegramUrl(input)),
  );
}
