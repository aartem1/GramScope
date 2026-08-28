import { describe, expect, it } from "vitest";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { registerTools } from "@/mcp/server";
import { MCP_SERVER_VERSION } from "@/mcp/version";
import { SERVER_INSTRUCTIONS } from "@/mcp/instructions";
import { readFileSync } from "node:fs";

type Json = Record<string, unknown>;

type Connected = {
  send: (message: Json) => Promise<void>;
  waitFor: (id: number) => Promise<Json>;
  close: () => Promise<void>;
};

/**
 * Connects a real McpServer over the SDK's in-memory transport, completes the
 * initialize handshake, and hands back the raw JSON-RPC channel plus the
 * initialize result. Both the tools/list tests and the instructions test drive
 * the same handshake, so it lives in one place.
 */
async function connectServer(): Promise<{
  channel: Connected;
  initialize: Json;
}> {
  const server = new McpServer(
    { name: "gramscope", version: "test" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerTools(server);

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
  const initializeResponse = await waitFor(1);

  await clientTransport.send({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  } as never);

  return {
    channel: {
      send: (message) => clientTransport.send(message as never),
      waitFor,
      close: () => server.close(),
    },
    initialize: initializeResponse.result as Json,
  };
}

/**
 * Drives a real McpServer over the SDK's in-memory transport and speaks raw
 * JSON-RPC on the other end. The hand-rolled fake in tools.test.ts asserts
 * that registerTools was called; this asserts that what it registered
 * survives the SDK's own schema conversion, which is where a bad inputSchema
 * actually fails.
 */
async function listTools(): Promise<Json[]> {
  const { channel } = await connectServer();

  try {
    await channel.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const response = await channel.waitFor(2);

    return ((response.result as Json).tools ?? []) as Json[];
  } finally {
    await channel.close();
  }
}

describe("tools/list over a real MCP server", () => {
  it("keeps the package and MCP server on app version 1.2.0", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown };
    const packageLock = JSON.parse(
      readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
    ) as {
      version?: unknown;
      packages?: Record<string, { version?: unknown }>;
    };

    expect(MCP_SERVER_VERSION).toBe("1.2.0");
    expect(packageJson.version).toBe(MCP_SERVER_VERSION);
    expect(packageLock.version).toBe(MCP_SERVER_VERSION);
    expect(packageLock.packages?.[""]?.version).toBe(MCP_SERVER_VERSION);
  });

  it("advertises all fourteen tools", async () => {
    const tools = await listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "get_channel",
      "get_message",
      "get_messages",
      "get_pinned_messages",
      "get_similar_channels",
      "get_thread",
      "get_unread_summary",
      "list_dialogs",
      "list_folders",
      "mark_read",
      "mark_unread",
      "resolve_telegram_url",
      "search_channels",
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

  it("marks only mark_read and mark_unread as mutating", async () => {
    const tools = await listTools();
    for (const tool of tools) {
      const annotations = (tool.annotations ?? {}) as Json;
      expect(annotations.readOnlyHint, String(tool.name)).toBe(
        tool.name !== "mark_read" && tool.name !== "mark_unread",
      );
    }
  });

  it("delivers the shared guidance in the initialize result", async () => {
    const { initialize } = await connectServer();
    expect(String(initialize.instructions)).toContain(
      "Name a source by @username whenever it has one",
    );
  });

  it("wires the same instructions into the deployed handler", () => {
    // A source assertion, not a behavioural one: app/api/mcp/route.ts builds
    // its handler at module scope from runtime env, so importing it here would
    // require the whole Next request environment. What can go wrong silently
    // is the constant being written but never passed, and that this catches.
    const route = readFileSync("app/api/mcp/route.ts", "utf8");
    expect(route).toContain("SERVER_INSTRUCTIONS");
  });
});
