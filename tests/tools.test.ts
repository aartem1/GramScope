import { describe, expect, it } from "vitest";
import { errorResult, okResult, runTool } from "@/mcp/tool-result";
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

  const READ_ONLY = [
    "get_channel",
    "get_message",
    "get_messages",
    "get_pinned_messages",
    "get_thread",
    "get_unread_summary",
    "list_dialogs",
    "list_folders",
    "resolve_telegram_url",
    "search_messages",
  ];

  it("registers all eleven tools", () => {
    const server = fakeServer();
    registerTools(server as never);
    expect(server.tools.map((t) => t.name).sort()).toEqual(
      [...READ_ONLY, "mark_read"].sort(),
    );
  });

  it("derives readOnlyHint from behaviour, not uniformly", () => {
    // The card's carried-forward decision: mark_read mutates account state,
    // and a client that trusts a uniform `true` would call it freely.
    const server = fakeServer();
    registerTools(server as never);
    for (const tool of server.tools) {
      expect(tool.config.annotations).toMatchObject({
        readOnlyHint: tool.name !== "mark_read",
      });
    }
  });

  it("says plainly in mark_read's description that it mutates state", () => {
    const server = fakeServer();
    registerTools(server as never);
    const markRead = server.tools.find((t) => t.name === "mark_read")!;
    expect(String(markRead.config.description).toLowerCase()).toContain(
      "changes account state",
    );
  });

  it("tells callers how to reuse sources that are not joined", () => {
    const server = fakeServer();
    registerTools(server as never);
    const sourceTools = [
      "get_channel",
      "get_message",
      "get_messages",
      "get_pinned_messages",
      "get_thread",
      "resolve_telegram_url",
      "search_messages",
    ];
    const contract =
      "Name a source by @username whenever it has one: a marked id like -1001234567890 resolves only for chats this account belongs to, so it is not a durable handle for a public channel reached by search or by link.";

    for (const name of sourceTools) {
      const tool = server.tools.find((candidate) => candidate.name === name)!;
      expect(String(tool.config.description), name).toContain(contract);
    }
  });
});

describe("countOf", () => {
  it("counts messages across a grouped response, not source blocks", async () => {
    const lines: string[] = [];
    await runTool(
      "get_messages",
      async () => ({
        sources: [
          {
            source_id: "-1001",
            title: "A",
            messages: [{}, {}],
            has_more: false,
          },
          { source_id: "-1002", title: "B", messages: [{}], has_more: false },
        ],
      }),
      (line) => lines.push(line),
    );
    expect(lines.join(" ")).toContain("count=3");
  });

  it("counts an all-error grouped message response as zero", async () => {
    const lines: string[] = [];
    await runTool(
      "get_messages",
      async () => ({
        sources: [
          {
            source_id: "-1001",
            title: "A",
            error: { code: "NOT_FOUND", message: "source unavailable" },
          },
          {
            source_id: "-1002",
            title: "B",
            error: { code: "FORBIDDEN", message: "source unavailable" },
          },
        ],
      }),
      (line) => lines.push(line),
    );
    expect(lines.join(" ")).toContain("count=0");
  });

  it("keeps counting flat dialog sources by array length", async () => {
    const lines: string[] = [];
    await runTool(
      "list_dialogs",
      async () => ({
        sources: [
          { id: "-1001", title: "A", type: "channel" },
          { id: "-1002", title: "B", type: "group" },
        ],
      }),
      (line) => lines.push(line),
    );
    expect(lines.join(" ")).toContain("count=2");
  });

  it("falls back to the array length for a flat response", async () => {
    const lines: string[] = [];
    await runTool(
      "list_folders",
      async () => ({ folders: [{}, {}] }),
      (line) => lines.push(line),
    );
    expect(lines.join(" ")).toContain("count=2");
  });
});
