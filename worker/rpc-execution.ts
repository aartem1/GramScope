import { OperationGate } from "./concurrency";
import { RpcDeadlineError } from "./deadline";

export type RpcExecutionResult =
  | { kind: "success"; result: unknown }
  | { kind: "deadline" }
  | { kind: "error"; error: unknown };

/**
 * Holds an operation gate permit until the underlying promise settles, even
 * when the RPC deadline fires first.
 */
export async function executeRpcOperation(
  gate: OperationGate,
  deadlineMs: number,
  operation: () => Promise<unknown>,
): Promise<RpcExecutionResult> {
  await gate.acquire();
  const operationPromise = operation();
  const settled = operationPromise.finally(() => {
    gate.release();
  });
  void settled.catch(() => undefined);

  try {
    const result = await Promise.race([
      operationPromise,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new RpcDeadlineError()), deadlineMs);
      }),
    ]);
    return { kind: "success", result };
  } catch (err) {
    if (err instanceof RpcDeadlineError) {
      return { kind: "deadline" };
    }
    return { kind: "error", error: err };
  }
}
