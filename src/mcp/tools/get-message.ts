import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { getMessage, MAX_CONTEXT } from "../../telegram/messages";
import { telegramMessageSchema } from "../../schemas/message";
import { runTool } from "../tool-result";
import { OUTSIDE_SOURCE_GUIDANCE } from "../source-guidance";

export function registerGetMessage(server: McpServer): void {
  server.registerTool(
    "get_message",
    {
      title: "Read one Telegram message",
      description:
        `Read a single message by source id and message id, optionally with the messages immediately before and after it. Context arrays are in ascending date order; missing context is a shorter array, not an error. ${OUTSIDE_SOURCE_GUIDANCE} Read-only.`,
      inputSchema: z.object({
        source_id: z
          .string()
          .describe(
            "A marked id from list_dialogs, a @username, or a t.me link.",
          ),
        message_id: z.number().int(),
        context_before: z
          .number()
          .int()
          .min(0)
          .max(MAX_CONTEXT)
          .default(0)
          .describe("How many older messages to include."),
        context_after: z
          .number()
          .int()
          .min(0)
          .max(MAX_CONTEXT)
          .default(0)
          .describe("How many newer messages to include."),
      }),
      outputSchema: z.object({
        source_id: z.string(),
        source_title: z.string(),
        message: telegramMessageSchema,
        context_before: z.array(telegramMessageSchema),
        context_after: z.array(telegramMessageSchema),
      }),
      annotations: { readOnlyHint: true },
    },
    async (input) => runTool("get_message", () => getMessage(input)),
  );
}
