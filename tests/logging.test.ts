import { describe, expect, it, vi } from "vitest";
import { formatEvent, logEvent } from "@/mcp/logging";

describe("formatEvent", () => {
  it("reports tool name, duration and result count on completion", () => {
    const line = formatEvent({
      type: "REQUEST_COMPLETED",
      method: "tools/call",
      status: "success",
      duration: 132,
      result: { structuredContent: { sources: [{ id: "1" }, { id: "2" }] } },
    });
    expect(line).toContain("tools/call");
    expect(line).toContain("132");
    expect(line).toContain("count=2");
  });

  it("reports the error code rather than the raw message", () => {
    const line = formatEvent({
      type: "REQUEST_COMPLETED",
      method: "tools/call",
      status: "error",
      duration: 5,
      result: {
        isError: true,
        structuredContent: { code: "RATE_LIMITED", message: "slow down" },
      },
    });
    expect(line).toContain("RATE_LIMITED");
  });

  it("never emits payload bodies", () => {
    const line = formatEvent({
      type: "REQUEST_COMPLETED",
      method: "tools/call",
      status: "success",
      duration: 1,
      result: {
        structuredContent: {
          sources: [{ id: "1", title: "Secret Channel Name" }],
        },
      },
    });
    expect(line).not.toContain("Secret Channel Name");
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
