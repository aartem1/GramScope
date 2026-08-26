export type McpEventLike = {
  type: string;
  method?: string;
  status?: string;
  duration?: number;
  error?: unknown;
};

/**
 * Builds a log line from an mcp-handler event: the JSON-RPC method, its status
 * and its duration, and nothing else. mcp-handler never populates
 * `event.result`, so counts and error codes are not derivable here — they come
 * from formatToolCall below. Deliberately reading no payload at all keeps a
 * later widening to REQUEST_RECEIVED, which carries the whole JSON-RPC
 * request, from quietly logging search queries or note bodies.
 */
export function formatEvent(event: McpEventLike): string | undefined {
  if (event.type === "ERROR") {
    return `mcp error source=system`;
  }
  if (event.type !== "REQUEST_COMPLETED") return undefined;

  const parts = [`mcp method=${event.method ?? "unknown"}`];
  if (event.status) parts.push(`status=${event.status}`);
  if (typeof event.duration === "number") {
    parts.push(`duration_ms=${event.duration}`);
  }

  return parts.join(" ");
}

export function logEvent(
  event: McpEventLike,
  sink: (line: string) => void = console.log,
): void {
  const line = formatEvent(event);
  if (line) sink(line);
}

export type ToolCallLog = {
  name: string;
  durationMs: number;
  status: "success" | "error";
  count?: number;
  code?: string;
};

/**
 * Tool-level logging. mcp-handler's REQUEST_COMPLETED event carries only the
 * generic JSON-RPC method ("tools/call") and no result, so the tool name,
 * result count and error class are not derivable from it. They are recorded
 * here instead, where the call actually happens.
 */
export function formatToolCall(entry: ToolCallLog): string {
  const parts = [
    `mcp tool=${entry.name}`,
    `status=${entry.status}`,
    `duration_ms=${entry.durationMs}`,
  ];
  if (entry.count !== undefined) parts.push(`count=${entry.count}`);
  if (entry.code) parts.push(`code=${entry.code}`);
  return parts.join(" ");
}

export function logToolCall(
  entry: ToolCallLog,
  sink: (line: string) => void = console.log,
): void {
  sink(formatToolCall(entry));
}
