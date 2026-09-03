export class RpcDeadlineError extends Error {
  constructor() {
    super("Worker RPC deadline exceeded");
    this.name = "RpcDeadlineError";
  }
}

export async function withDeadline<T>(
  deadlineMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new RpcDeadlineError()), deadlineMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
