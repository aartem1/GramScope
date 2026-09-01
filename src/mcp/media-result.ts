import type { MediaOutcome } from "../media/service";
import type { ToolResult } from "./tool-result";

export function mediaToolResult(outcome: MediaOutcome): ToolResult {
  const { result, link } = outcome;
  const content: ToolResult["content"] = [{
    type: "text",
    text: `${result.status}: ${result.representation?.kind ?? "metadata"}`,
  }];
  if (link) content.push({
    type: "resource_link",
    uri: link.uri,
    name: link.name,
    ...(link.mimeType ? { mimeType: link.mimeType } : {}),
    ...(link.size !== undefined ? { size: link.size } : {}),
  });
  return {
    content,
    structuredContent: result,
    ...(result.status === "error" ? { isError: true } : {}),
  };
}
