import { describe, expect, it } from "vitest";
import { errorResult, okResult } from "@/mcp/tool-result";
import { GramScopeError } from "@/errors/taxonomy";
import { registerTools } from "@/mcp/server";

describe("tool results", () => {
  it("wraps data as structured content plus text", () => {
    const result = okResult({ sources: [] });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ sources: [] });
    expect(result.content[0]!.type).toBe("text");
  });

  it("renders a taxonomy error as structured content", () => {
    const result = errorResult(
      new GramScopeError("RATE_LIMITED", "slow down", 42),
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: "RATE_LIMITED",
      retry_after_seconds: 42,
    });
  });

  it("maps an unknown throw to INTERNAL_ERROR without leaking its message", () => {
    const result = errorResult(new Error("session=SECRETVALUE"));
    expect(result.structuredContent).toMatchObject({
      code: "INTERNAL_ERROR",
    });
    expect(JSON.stringify(result)).not.toContain("SECRETVALUE");
  });
});

describe("registerTools", () => {
  function fakeServer() {
    const tools: Array<{ name: string; config: Record<string, unknown> }> = [];
    return {
      tools,
      registerTool(name: string, config: Record<string, unknown>) {
        tools.push({ name, config });
      },
    };
  }

  it("registers exactly the three Foundation tools", () => {
    const server = fakeServer();
    registerTools(server as never);
    expect(server.tools.map((t) => t.name).sort()).toEqual([
      "get_channel",
      "list_dialogs",
      "list_folders",
    ]);
  });

  it("marks every tool read-only", () => {
    const server = fakeServer();
    registerTools(server as never);
    for (const tool of server.tools) {
      expect(tool.config.annotations).toMatchObject({ readOnlyHint: true });
    }
  });

  it("gives every tool a description and an output schema", () => {
    const server = fakeServer();
    registerTools(server as never);
    for (const tool of server.tools) {
      expect(tool.config.description).toBeTruthy();
      expect(tool.config.outputSchema).toBeTruthy();
    }
  });
});
