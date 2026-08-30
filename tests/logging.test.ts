import { describe, expect, it, vi } from "vitest";
import { formatEvent, formatToolCall, logEvent } from "@/mcp/logging";
import { runTool } from "@/mcp/tool-result";
import { GramScopeError } from "@/errors/taxonomy";

describe("formatEvent", () => {
  it("reports the method, status and duration of a completed request", () => {
    const line = formatEvent({
      type: "REQUEST_COMPLETED",
      method: "tools/call",
      status: "success",
      duration: 132,
    });
    expect(line).toContain("tools/call");
    expect(line).toContain("status=success");
    expect(line).toContain("duration_ms=132");
  });

  it("ignores events that carry no useful signal", () => {
    expect(formatEvent({ type: "REQUEST_RECEIVED", method: "tools/call" }))
      .toBeUndefined();
  });

  it("writes through the injected sink", () => {
    const sink = vi.fn();
    logEvent(
      { type: "REQUEST_COMPLETED", method: "tools/list", duration: 3 },
      sink,
    );
    expect(sink).toHaveBeenCalledOnce();
  });
});

describe("runTool logging", () => {
  it("logs only safe media fields", () => {
    const line = formatToolCall({
      name: "get_media",
      durationMs: 12,
      status: "success",
      mediaKind: "photo",
      bytes: 321,
      url: "https://media.example/SECRET_URL",
      token: "SECRET_TOKEN",
      filename: "secret-name.jpg",
      caption: "SECRET_CAPTION",
    } as never);

    expect(line).toContain("media_kind=photo");
    expect(line).toContain("bytes=321");
    expect(line).not.toContain("SECRET_URL");
    expect(line).not.toContain("SECRET_TOKEN");
    expect(line).not.toContain("secret-name.jpg");
    expect(line).not.toContain("SECRET_CAPTION");
  });

  it("names the tool and counts the results on success", async () => {
    const sink = vi.fn();
    const result = await runTool(
      "list_dialogs",
      async () => ({ sources: [{ id: "1" }, { id: "2" }] }),
      sink,
    );
    expect(result.isError).toBeUndefined();
    const line = sink.mock.calls[0]![0] as string;
    expect(line).toContain("tool=list_dialogs");
    expect(line).toContain("status=success");
    expect(line).toContain("count=2");
    expect(line).toMatch(/duration_ms=\d+/);
  });

  it("logs the error code and returns a structured error", async () => {
    const sink = vi.fn();
    const result = await runTool(
      "get_channel",
      async () => {
        throw new GramScopeError("CHANNEL_NOT_FOUND", "nope");
      },
      sink,
    );
    expect(result.isError).toBe(true);
    const line = sink.mock.calls[0]![0] as string;
    expect(line).toContain("tool=get_channel");
    expect(line).toContain("code=CHANNEL_NOT_FOUND");
  });

  it("never writes payload bodies into the log line", async () => {
    const sink = vi.fn();
    await runTool(
      "list_dialogs",
      async () => ({
        sources: [{ id: "1", title: "Secret Channel Name" }],
      }),
      sink,
    );
    expect(sink.mock.calls[0]![0]).not.toContain("Secret Channel Name");
  });

  it("contains a throw rather than letting it reach the transport", async () => {
    const sink = vi.fn();
    await expect(
      runTool("list_folders", async () => {
        throw new Error("boom");
      }, sink),
    ).resolves.toMatchObject({ isError: true });
  });

  it("counts a flat search page by its hits, not by its sources", async () => {
    const lines: string[] = [];
    await runTool(
      "search_messages",
      async () => ({
        results: [
          { id: 1, chat_id: "-100111", date: "x", source_title: "Alpha" },
          { id: 2, chat_id: "-100222", date: "x", source_title: "Beta" },
          { id: 3, chat_id: "-100222", date: "x", source_title: "Beta" },
        ],
        sources: [
          { source_id: "-100111", title: "Alpha", hit_count: 1 },
          { source_id: "-100222", title: "Beta", hit_count: 2 },
        ],
      }),
      (line) => lines.push(line),
    );
    expect(lines[0]).toContain("count=3");
  });
});
