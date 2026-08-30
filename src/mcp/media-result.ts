import type { MediaOutcome } from "../media/service";
import type { ToolResult } from "./tool-result";

export function mediaToolResult(outcome: MediaOutcome): ToolResult {
  const { result, artifact, link } = outcome;
  const content: ToolResult["content"] = [{
    type: "text",
    text: `${result.status}: ${result.representation?.kind ?? "metadata"}`,
  }];
  if (artifact) content.push({
    type: artifact.type,
    data: artifact.data.toString("base64"),
    mimeType: artifact.mimeType,
  });
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
