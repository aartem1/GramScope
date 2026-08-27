import { GramScopeError, type StructuredError } from "../errors/taxonomy";
import { mapTelegramError } from "../errors/from-telegram";
import { logToolCall } from "./logging";

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: unknown;
  isError?: true;
};

export function okResult<T>(data: T): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

export function errorResult(err: unknown): ToolResult {
  const mapped: GramScopeError =
    err instanceof GramScopeError ? err : mapTelegramError(err);
  const structured: StructuredError = mapped.toStructured();
  return {
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured,
    isError: true,
  };
}

function messageCount(items: unknown[]): number | undefined {
  let total: number | undefined;
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const messages = record.messages;
    if (Array.isArray(messages)) {
      total = (total ?? 0) + messages.length;
    } else if ("error" in record) {
      total ??= 0;
    }
  }
  return total;
}

/**
 * The log line reports how much a call actually returned. For the grouped
 * multi-source shape that is the message count, not the number of source
 * blocks — three blocks holding sixty messages is not "3".
 */
function countOf(data: unknown): number | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  // `results` first: a flat search page carries BOTH a results list and a
  // sources roll-up, and what the call returned is the hits, not the number
  // of sources they came from.
  for (const key of ["results", "sources", "folders", "groups"]) {
    const value = (data as Record<string, unknown>)[key];
    if (!Array.isArray(value)) continue;
    return messageCount(value) ?? value.length;
  }
  return undefined;
}

/**
 * Runs one tool: times it, converts the outcome into a ToolResult, and records
 * a log line naming the tool. Every tool body goes through this, so no handler
 * can throw out into the transport and none is missing from the logs.
 */
export async function runTool<T>(
  name: string,
  run: () => Promise<T>,
  sink?: (line: string) => void,
): Promise<ToolResult> {
  const started = Date.now();
  try {
    const data = await run();
    logToolCall(
      {
        name,
        durationMs: Date.now() - started,
        status: "success",
        ...(countOf(data) !== undefined ? { count: countOf(data) } : {}),
      },
      sink,
    );
    return okResult(data);
  } catch (err) {
    const result = errorResult(err);
    logToolCall(
      {
        name,
        durationMs: Date.now() - started,
        status: "error",
        code: (result.structuredContent as StructuredError).code,
      },
      sink,
    );
    return result;
  }
}
