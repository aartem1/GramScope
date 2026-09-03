import type { McpServer } from "@modelcontextprotocol/server";
import {
  getMediaInputSchema,
  getMediaResultSchema,
  type GetMediaInput,
} from "../../schemas/media";
import { getMedia, type MediaOutcome } from "../../ops";
import { logToolCall } from "../logging";
import { mediaToolResult } from "../media-result";
import { errorCodeOf, errorResult, type ToolResult } from "../tool-result";

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
      ...(outcome.result.code ? { code: outcome.result.code } : {}),
    }, sink);
    return result;
  } catch (err) {
    const result = errorResult(err);
    const code = errorCodeOf(result);
    logToolCall({
      name: "get_media",
      durationMs: Date.now() - started,
      status: "error",
      ...(code ? { code } : {}),
    }, sink);
    return result;
  }
}

export function registerGetMedia(server: McpServer): void {
  server.registerTool("get_media", {
    title: "Inspect Telegram media",
    description: "Retrieve media attached to one Telegram message when its contents may affect the answer. Pass source_id and message_id and normally omit mode. GramScope returns one short-lived resource link to the best representation. Open it once. Do not retry get_media automatically if file materialization is denied, fails, or the link expires.",
    inputSchema: getMediaInputSchema,
    outputSchema: getMediaResultSchema,
    annotations: { readOnlyHint: true },
  }, async (input) => {
    const parsed = getMediaInputSchema.parse(input);
    return runGetMediaTool(parsed);
  });
}
