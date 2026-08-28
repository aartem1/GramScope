import { describe, expect, it } from "vitest";
import { errorResult, okResult, runTool } from "@/mcp/tool-result";
import { GramScopeError } from "@/errors/taxonomy";
import { registerTools } from "@/mcp/server";
import { SERVER_INSTRUCTIONS } from "@/mcp/instructions";
import { WRITERS } from "./tool-names";

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
    "get_similar_channels",
    "get_thread",
    "get_unread_summary",
    "list_dialogs",
    "list_folders",
    "resolve_telegram_url",
    "search_channels",
    "search_messages",
  ];

  it("registers all seventeen tools", () => {
    const server = fakeServer();
    registerTools(server as never);
    expect(server.tools.map((t) => t.name).sort()).toEqual(
      [...READ_ONLY, ...WRITERS].sort(),
    );
  });

  it("names every manage_folder action in its schema", () => {
    const server = fakeServer();
    registerTools(server as never);
    const tool = server.tools.find((t) => t.name === "manage_folder")!;
    const schema = tool.config.inputSchema as {
      shape: { action: { options: string[] } };
    };
    // Spread before sorting: sort() is in place and `options` is the live
    // schema's own array.
    expect([...schema.shape.action.options].sort()).toEqual(
      [
        "add_sources",
        "create",
        "delete",
        "remove_sources",
        "rename",
        "reorder",
      ].sort(),
    );
  });

  it("says in manage_folder's description that delete takes one folder", () => {
    const server = fakeServer();
    registerTools(server as never);
    const tool = server.tools.find((t) => t.name === "manage_folder")!;
    expect(String(tool.config.description)).toContain("one folder");
  });

  it("derives readOnlyHint from behaviour, not uniformly", () => {
    // The card's carried-forward decision: mark_read mutates account state,
    // and a client that trusts a uniform `true` would call it freely.
    const server = fakeServer();
    registerTools(server as never);
    for (const tool of server.tools) {
      expect(tool.config.annotations).toMatchObject({
        readOnlyHint: !WRITERS.includes(tool.name),
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

  it("says plainly that mark_unread changes account state and is not a count", () => {
    const server = fakeServer();
    registerTools(server as never);
    const tool = server.tools.find((t) => t.name === "mark_unread")!;
    const description = String(tool.config.description).toLowerCase();
    expect(description).toContain("changes account state");
    // The trap this description exists to close: unreadMark and unreadCount
    // are independent, so a caller who reads this as "mark unread" in the
    // message-count sense will expect messages to become readable again.
    expect(description).toContain("separate from the unread count");
  });

  it("warns in leave_channel's description that a private channel is unrecoverable", () => {
    const server = fakeServer();
    registerTools(server as never);
    const tool = server.tools.find((t) => t.name === "leave_channel")!;
    expect(String(tool.config.description)).toContain("without a new invite");
  });

  it("says the source addressing rule once, in the server instructions", () => {
    // Spec §8: the same paragraph in nine descriptions is paid for on every
    // tools/list. It is now delivered once, in the initialize result.
    expect(SERVER_INSTRUCTIONS).toContain(
      "Name a source by @username whenever it has one",
    );
    expect(SERVER_INSTRUCTIONS).toContain("third-party data");
  });

  it("repeats no shared guidance inside any tool description", () => {
    const server = fakeServer();
    registerTools(server as never);
    for (const tool of server.tools) {
      expect(
        String(tool.config.description),
        `${tool.name} still carries the shared guidance`,
      ).not.toContain("Name a source by @username");
    }
  });

  it("tells callers that search_channels matches names, not topics", () => {
    // Measured 2026-08-28: q="AI" returns nothing while q="artificial
    // intelligence" returns nine channels. A model that reads this tool as
    // a topical search engine reports that no such channels exist.
    const server = fakeServer();
    registerTools(server as never);
    const tool = server.tools.find((t) => t.name === "search_channels")!;
    const description = String(tool.config.description);
    expect(description).toContain("by name");
    expect(description).toContain("not by topic");
    expect(description).toContain("get_similar_channels");
  });

  it("states the distinct seeded and global recommendation ceilings", () => {
    const server = fakeServer();
    registerTools(server as never);
    const tool = server.tools.find((t) => t.name === "get_similar_channels")!;
    const description = String(tool.config.description);
    expect(description).toContain(
      "With source supplied, total_similar is the number Telegram knows; only about 10 are served, the remainder requires Telegram Premium, and no argument reaches it.",
    );
    expect(description).toContain(
      "With source omitted, Telegram may offer about 100 ordinary account recommendations; GramScope safely returns only the first limit (maximum 10); there is no pagination or cursor; repeating the same call does not reach the remainder.",
    );
    expect(description).toContain("never re-ranked");
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
