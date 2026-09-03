import { describe, expect, it } from "vitest";
import { OperationGate } from "../worker/concurrency";
import { executeRpcOperation } from "../worker/rpc-execution";

describe("executeRpcOperation", () => {
  it("keeps the gate permit until a timed-out operation settles", async () => {
    const gate = new OperationGate(1, 50);
    let finishSlow: () => void = () => undefined;
    const slowUnderlying = new Promise<{ done: true }>((resolve) => {
      finishSlow = () => resolve({ done: true });
    });

    const slow = executeRpcOperation(gate, 20, () => slowUnderlying);

    await new Promise((resolve) => setTimeout(resolve, 30));

    let secondStarted = false;
    const queued = executeRpcOperation(gate, 100, async () => {
      secondStarted = true;
      return { ok: true };
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(secondStarted).toBe(false);

    finishSlow();
    await expect(slow).resolves.toEqual({ kind: "deadline" });
    await expect(queued).resolves.toEqual({
      kind: "success",
      result: { ok: true },
    });
    expect(secondStarted).toBe(true);
  });

  it("returns success when the operation finishes before the deadline", async () => {
    const gate = new OperationGate(1, 50);
    await expect(
      executeRpcOperation(gate, 100, async () => ({ n: 2 })),
    ).resolves.toEqual({ kind: "success", result: { n: 2 } });
  });
});
