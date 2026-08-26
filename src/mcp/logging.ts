export type McpEventLike = {
  type: string;
  method?: string;
  status?: string;
  duration?: number;
  result?: unknown;
  error?: unknown;
};

function resultCount(result: unknown): number | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const structured = (result as { structuredContent?: unknown })
    .structuredContent;
  if (typeof structured !== "object" || structured === null) return undefined;
  for (const key of ["sources", "folders"]) {
    const value = (structured as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value.length;
  }
  return undefined;
}

function errorCode(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const structured = (result as { structuredContent?: unknown })
    .structuredContent;
  if (typeof structured !== "object" || structured === null) return undefined;
  const code = (structured as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Builds a log line from an mcp-handler event. Only names, codes, counts and
 * timings are emitted — never payload bodies, tokens, or session strings.
 */
export function formatEvent(event: McpEventLike): string | undefined {
  if (event.type === "ERROR") {
    return `mcp error source=system`;
  }
  if (event.type !== "REQUEST_COMPLETED") return undefined;

  const parts = [`mcp method=${event.method ?? "unknown"}`];
  if (event.status) parts.push(`status=${event.status}`);
  if (typeof event.duration === "number") parts.push(`duration_ms=${event.duration}`);

  const count = resultCount(event.result);
  if (count !== undefined) parts.push(`count=${count}`);

  const code = errorCode(event.result);
  if (code) parts.push(`code=${code}`);

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
