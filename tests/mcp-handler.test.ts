import { describe, expect, it } from "vitest";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { registerTools } from "@/mcp/server";

type Json = Record<string, unknown>;

/**
 * Drives a real McpServer over the SDK's in-memory transport and speaks raw
 * JSON-RPC on the other end. The hand-rolled fake in tools.test.ts asserts
 * that registerTools was called; this asserts that what it registered
 * survives the SDK's own schema conversion, which is where a bad inputSchema
 * actually fails.
 */
async function listTools(): Promise<Json[]> {
  const server = new McpServer({ name: "gramscope", version: "test" });
  registerTools(server);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  try {
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

    await clientTransport.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    } as never);
    const response = await waitFor(2);

    return ((response.result as Json).tools ?? []) as Json[];
  } finally {
    await server.close();
  }
}

describe("tools/list over a real MCP server", () => {
  it("advertises all ten tools", async () => {
    const tools = await listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "get_channel",
      "get_message",
      "get_messages",
      "get_thread",
      "get_unread_summary",
      "list_dialogs",
      "list_folders",
      "mark_read",
      "resolve_telegram_url",
      "search_messages",
    ]);
  });

  it("gives every tool a usable object input schema", async () => {
    const tools = await listTools();
    for (const tool of tools) {
      const schema = tool.inputSchema as Json | undefined;
      expect(schema, `${String(tool.name)} has no inputSchema`).toBeTruthy();
      expect(schema!.type).toBe("object");
      expect(typeof tool.description).toBe("string");
      expect(String(tool.description).length).toBeGreaterThan(40);
    }
  });

  it("marks only mark_read as mutating", async () => {
    const tools = await listTools();
    for (const tool of tools) {
      const annotations = (tool.annotations ?? {}) as Json;
      expect(annotations.readOnlyHint, String(tool.name)).toBe(
        tool.name !== "mark_read",
      );
    }
  });
});
