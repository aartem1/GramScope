import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GramScopeError } from "@/errors/taxonomy";
import { registerTools } from "@/mcp/server";
import { createDispatcher, operationNames } from "@/ops";

describe("operation registry completeness", () => {
  function fakeServer() {
    const tools: Array<{ name: string; config: Record<string, unknown> }> = [];
    return {
      tools,
      registerTool(name: string, config: Record<string, unknown>) {
        tools.push({ name, config });
      },
    };
  }

  it("registers exactly the same names as the MCP tools", () => {
    const server = fakeServer();
    registerTools(server as never);
    const toolNames = server.tools.map((tool) => tool.name).sort();
    const opNames = [...operationNames()].sort();
    expect(opNames).toEqual(toolNames);
  });
});

describe("in-process dispatch", () => {
  const echoInput = z.object({ n: z.number() });
  const echoOutput = z.object({ n: z.number() });

  it("round-trips a valid operation", async () => {
    const dispatch = createDispatcher({
      echo: {
        name: "echo",
        input: echoInput,
        output: echoOutput,
        handler: async (input: { n: number }) => ({ n: input.n + 1 }),
      },
    });

    await expect(dispatch("echo", { n: 1 })).resolves.toEqual({ n: 2 });
  });

  it("returns INTERNAL_ERROR for an unknown operation", async () => {
    const dispatch = createDispatcher({});

    await expect(dispatch("not_a_tool", {})).rejects.toMatchObject({
      name: "GramScopeError",
      code: "INTERNAL_ERROR",
    });
  });

  it("preserves a handler-thrown GramScopeError including retryAfterSeconds", async () => {
    const thrown = new GramScopeError("RATE_LIMITED", "slow down", 42);
    const dispatch = createDispatcher({
      boom: {
        name: "boom",
        input: z.object({}),
        output: z.object({}),
        handler: async () => {
          throw thrown;
        },
      },
    });

    try {
      await dispatch("boom", {});
      throw new Error("expected dispatch to throw");
    } catch (err) {
      expect(err).toBe(thrown);
      expect(err).toBeInstanceOf(GramScopeError);
      expect(err).toMatchObject({
        code: "RATE_LIMITED",
        message: "slow down",
        retryAfterSeconds: 42,
        retryable: true,
      });
    }
  });

  it("fails a wrong-shaped handler result as INTERNAL_ERROR without leaking it", async () => {
    const dispatch = createDispatcher({
      bad: {
        name: "bad",
        input: z.object({}),
        output: z.object({ n: z.number() }),
        handler: async () =>
          ({ n: "nope", session: "SECRETVALUE" }) as unknown as { n: number },
      },
    });

    try {
      await dispatch("bad", {});
      throw new Error("expected dispatch to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GramScopeError);
      expect(err).toMatchObject({ code: "INTERNAL_ERROR" });
      expect(String(err)).not.toContain("SECRETVALUE");
      expect(JSON.stringify(err)).not.toContain("SECRETVALUE");
    }
  });
});
