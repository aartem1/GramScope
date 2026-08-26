import { GramScopeError, type StructuredError } from "../errors/taxonomy";
import { mapTelegramError } from "../errors/from-telegram";

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
