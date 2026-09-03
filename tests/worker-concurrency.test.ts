import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_CONCURRENT_OPERATIONS,
  DEFAULT_OPERATION_QUEUE_WAIT_MS,
  OperationGate,
  OperationQueueTimeoutError,
} from "../worker/concurrency";
import { RpcDeadlineError, withDeadline } from "../worker/deadline";
import { DEFAULT_RPC_DEADLINE_MS } from "@/ops/wire";

describe("OperationGate", () => {
  it("caps concurrent operations and rejects queue waits", async () => {
    const gate = new OperationGate(1, 20);
    await gate.acquire();
    await expect(gate.acquire()).rejects.toBeInstanceOf(
      OperationQueueTimeoutError,
    );
    gate.release();
  });

  it("runs work under the configured cap", async () => {
    const gate = new OperationGate(2, 50);
    let peak = 0;
    let inFlight = 0;

    await Promise.all(
      Array.from({ length: 4 }, () =>
        gate.run(async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
        }),
      ),
    );

    expect(peak).toBeLessThanOrEqual(2);
  });

  it("exports named worker defaults", () => {
    expect(DEFAULT_MAX_CONCURRENT_OPERATIONS).toBeGreaterThan(0);
    expect(DEFAULT_OPERATION_QUEUE_WAIT_MS).toBeGreaterThan(0);
    expect(DEFAULT_RPC_DEADLINE_MS).toBe(50_000);
  });
});

describe("withDeadline", () => {
  it("times out long-running work", async () => {
    await expect(
      withDeadline(10, () => new Promise((resolve) => setTimeout(resolve, 50))),
    ).rejects.toBeInstanceOf(RpcDeadlineError);
  });
});
