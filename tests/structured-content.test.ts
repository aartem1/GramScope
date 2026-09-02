import { describe, expect, it } from "vitest";
import { z } from "zod";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { errorResult, okResult, runTool } from "@/mcp/tool-result";
import { GramScopeError } from "@/errors/taxonomy";
import { registerTools } from "@/mcp/server";

type Json = Record<string, unknown>;

type Connected = {
  send: (message: Json) => Promise<void>;
  waitFor: (id: number) => Promise<Json>;
  close: () => Promise<void>;
};

/**
 * Cursor validates tools/call structuredContent against the advertised
 * outputSchema with additionalProperties: false. Taxonomy errors in
 * structuredContent therefore surface as -32602 ("missing required … /
 * must NOT have additional properties") before the agent sees the payload.
 */
async function connectWithTools(
  register: (server: McpServer) => void,
): Promise<Connected> {
  const server = new McpServer({ name: "gramscope", version: "test" });
  register(server);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const inbox: Json[] = [];
  clientTransport.onmessage = (message) => inbox.push(message as Json);
  await clientTransport.start();

  const waitFor = async (id: number): Promise<Json> => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const found = inbox.find((message) => message.id === id);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`no response to request ${id}`);
  };

  await clientTransport.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    },
  } as never);
  await waitFor(1);
  await clientTransport.send({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  } as never);

  return {
    send: (message) => clientTransport.send(message as never),
    waitFor,
    close: () => server.close(),
  };
}

function assertMatchesOutputSchema(
  structuredContent: unknown,
  outputSchema: z.ZodType,
  toolName: string,
): void {
  const parsed = outputSchema.safeParse(structuredContent);
  expect(
    parsed.success,
    `${toolName} structuredContent failed outputSchema: ${parsed.success ? "" : parsed.error.message}`,
  ).toBe(true);

  const jsonSchema = z.toJSONSchema(outputSchema) as Json;
  expect(jsonSchema.additionalProperties, toolName).toBe(false);
  for (const key of Object.keys(structuredContent as object)) {
    expect(
      Object.keys((jsonSchema.properties as Json) ?? {}),
      `${toolName} has undeclared top-level key ${key}`,
    ).toContain(key);
  }
}

describe("structuredContent vs outputSchema", () => {
  it("keeps taxonomy errors out of structuredContent", () => {
    const result = errorResult(
      new GramScopeError("AUTH_REQUIRED", "Telegram error: AUTH_KEY_DUPLICATED"),
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.parse(String((result.content[0] as { text: string }).text))).toEqual({
      code: "AUTH_REQUIRED",
      message: "Telegram error: AUTH_KEY_DUPLICATED",
    });
  });

  it("advertises strict success schemas for the tools Cursor rejected", () => {
    const tools: Array<{ name: string; config: Record<string, unknown> }> = [];
    registerTools({
      registerTool(name: string, config: Record<string, unknown>) {
        tools.push({ name, config });
      },
    } as never);

    for (const name of ["mark_read", "get_unread_summary", "get_messages"]) {
      const tool = tools.find((entry) => entry.name === name);
      expect(tool, name).toBeTruthy();
      const schema = tool!.config.outputSchema as z.ZodType;
      const jsonSchema = z.toJSONSchema(schema) as Json;
      expect(jsonSchema.type, name).toBe("object");
      expect(jsonSchema.additionalProperties, name).toBe(false);
    }
  });

  it("returns success structuredContent that matches each tool outputSchema", async () => {
    const fixtures: Record<string, { schema: z.ZodType; data: unknown }> = {};

    const tools: Array<{ name: string; config: Record<string, unknown> }> = [];
    registerTools({
      registerTool(name: string, config: Record<string, unknown>) {
        tools.push({ name, config });
      },
    } as never);

    const markRead = tools.find((tool) => tool.name === "mark_read")!;
    const unread = tools.find((tool) => tool.name === "get_unread_summary")!;
    const messages = tools.find((tool) => tool.name === "get_messages")!;

    fixtures.mark_read = {
      schema: markRead.config.outputSchema as z.ZodType,
      data: { results: [], failures: [] },
    };
    fixtures.get_unread_summary = {
      schema: unread.config.outputSchema as z.ZodType,
      data: { groups: [], total_unread: 0 },
    };
    fixtures.get_messages = {
      schema: messages.config.outputSchema as z.ZodType,
      data: { sources: [] },
    };

    for (const [name, fixture] of Object.entries(fixtures)) {
      const result = okResult(fixture.data);
      assertMatchesOutputSchema(result.structuredContent, fixture.schema, name);
    }
  });

  it("tools/call success payloads validate and error payloads omit structuredContent", async () => {
    const channel = await connectWithTools((server) => {
      server.registerTool(
        "get_unread_summary",
        {
          description:
            "Report unread counts. Test double used to assert structuredContent shape.",
          inputSchema: z.object({
            group_by: z.enum(["source", "folder"]).default("source"),
          }),
          outputSchema: z.object({
            groups: z.array(
              z.object({
                title: z.string(),
                unread_count: z.number().int(),
              }),
            ),
            total_unread: z.number().int(),
          }),
        },
        async () =>
          runTool("get_unread_summary", async () => ({
            groups: [],
            total_unread: 0,
          })),
      );
      server.registerTool(
        "get_messages",
        {
          description:
            "Read messages. Test double used to assert structuredContent shape.",
          inputSchema: z.object({
            limit: z.number().int().default(20),
          }),
          outputSchema: z.object({
            sources: z.array(
              z.object({
                source_id: z.string(),
                title: z.string(),
              }),
            ),
          }),
        },
        async () =>
          runTool("get_messages", async () => ({
            sources: [{ source_id: "-1001", title: "Example" }],
          })),
      );
      server.registerTool(
        "mark_read",
        {
          description:
            "Mark sources read. Test double used to assert structuredContent shape.",
          inputSchema: z.object({
            source_ids: z.array(z.string()).min(1),
          }),
          outputSchema: z.object({
            results: z.array(
              z.object({
                source_id: z.string(),
                read_inbox_max_id: z.number().int(),
              }),
            ),
            failures: z.array(
              z.object({
                source_id: z.string(),
                code: z.string(),
                message: z.string(),
              }),
            ),
          }),
        },
        async () =>
          runTool("mark_read", async () => {
            throw new GramScopeError(
              "AUTH_REQUIRED",
              "Telegram error: AUTH_KEY_DUPLICATED",
            );
          }),
      );
    });

    try {
      await channel.send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_unread_summary", arguments: {} },
      });
      const unread = await channel.waitFor(2);
      const unreadResult = unread.result as Json;
      expect(unreadResult.isError).toBeUndefined();
      expect(unreadResult.structuredContent).toEqual({
        groups: [],
        total_unread: 0,
      });

      await channel.send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "get_messages", arguments: {} },
      });
      const messages = await channel.waitFor(3);
      const messagesResult = messages.result as Json;
      expect(messagesResult.structuredContent).toEqual({
        sources: [{ source_id: "-1001", title: "Example" }],
      });

      await channel.send({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "mark_read",
          arguments: { source_ids: ["@example"] },
        },
      });
      const markRead = await channel.waitFor(4);
      const markReadResult = markRead.result as Json;
      expect(markReadResult.isError).toBe(true);
      expect(markReadResult.structuredContent).toBeUndefined();
      expect(JSON.parse(String((markReadResult.content as Json[])[0]!.text))).toMatchObject({
        code: "AUTH_REQUIRED",
      });
    } finally {
      await channel.close();
    }
  });
});
