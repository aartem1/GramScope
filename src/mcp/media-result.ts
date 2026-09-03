import { GramScopeError } from "../errors/taxonomy";
import type { MediaOutcome } from "../media/service";
import type { ToolResult } from "./tool-result";

export const MAX_MEDIA_TOOL_RESULT_BYTES = 32 * 1024;

export function mediaToolResult(outcome: MediaOutcome): ToolResult {
  const { result, link } = outcome;
  const content: ToolResult["content"] = [{
    type: "text",
    text: `${result.status}: ${result.representation?.kind ?? "metadata"}`,
  }];
  if (link?.uri) content.push({
    type: "resource_link",
    uri: link.uri,
    name: link.name,
    ...(link.mimeType ? { mimeType: link.mimeType } : {}),
    ...(link.size !== undefined ? { size: link.size } : {}),
  });
  const toolResult: ToolResult = {
    content,
    structuredContent: result,
    ...(result.status === "error" ? { isError: true } : {}),
  };
  if (
    Buffer.byteLength(JSON.stringify(toolResult), "utf8") >=
    MAX_MEDIA_TOOL_RESULT_BYTES
  ) {
    throw new GramScopeError(
      "INTERNAL_ERROR",
      "The media result exceeds the 32 KiB response limit.",
    );
  }
  return toolResult;
}
