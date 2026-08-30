import type { McpServer } from "@modelcontextprotocol/server";
import {
  getMediaInputSchema,
  getMediaResultSchema,
  type GetMediaInput,
} from "../../schemas/media";
import { getMedia, type MediaOutcome } from "../../media/service";
import { type StructuredError } from "../../errors/taxonomy";
import { logToolCall } from "../logging";
import { mediaToolResult } from "../media-result";
import { errorResult, type ToolResult } from "../tool-result";

export async function runGetMediaTool(
  input: GetMediaInput,
  load: (input: GetMediaInput) => Promise<MediaOutcome> = getMedia,
  sink?: (line: string) => void,
): Promise<ToolResult> {
  const started = Date.now();
  try {
    const outcome = await load(input);
    const result = mediaToolResult(outcome);
    logToolCall({
      name: "get_media",
      durationMs: Date.now() - started,
      status: "success",
      ...(outcome.result.media?.type ? { mediaKind: outcome.result.media.type } : {}),
      ...(outcome.result.representation?.byte_size !== undefined
        ? { bytes: outcome.result.representation.byte_size }
        : {}),
    }, sink);
    return result;
  } catch (err) {
    const result = errorResult(err);
    logToolCall({
      name: "get_media",
      durationMs: Date.now() - started,
      status: "error",
      code: (result.structuredContent as StructuredError).code,
    }, sink);
    return result;
  }
}

export function registerGetMedia(server: McpServer): void {
  server.registerTool("get_media", {
    title: "Inspect Telegram media",
    description: "Retrieve the media attached to one Telegram message when its contents may affect the answer. Pass source_id and message_id; normally omit mode because GramScope returns the best bounded representation automatically.",
    inputSchema: getMediaInputSchema,
    outputSchema: getMediaResultSchema,
    annotations: { readOnlyHint: true },
  }, async (input) => {
    const parsed = getMediaInputSchema.parse(input);
    return runGetMediaTool(parsed);
  });
}
