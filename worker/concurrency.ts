/** Global cap on concurrently executing worker operations. */
export const DEFAULT_MAX_CONCURRENT_OPERATIONS = 16;

/** Bounded wait before a queued operation is rejected without starting. */
export const DEFAULT_OPERATION_QUEUE_WAIT_MS = 5_000;

type QueueEntry = {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class OperationGate {
  private active = 0;
  private readonly queue: QueueEntry[] = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly queueWaitMs: number,
  ) {}

  async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const entry: QueueEntry = {
        resolve: () => {
          clearTimeout(entry.timer);
          this.active += 1;
          resolve();
        },
        reject: (err) => {
          clearTimeout(entry.timer);
          reject(err);
        },
        timer: setTimeout(() => {
          const index = this.queue.indexOf(entry);
          if (index !== -1) this.queue.splice(index, 1);
          reject(new OperationQueueTimeoutError());
        }, this.queueWaitMs),
      };
      this.queue.push(entry);
    });
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    next?.resolve();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

export class OperationQueueTimeoutError extends Error {
  constructor() {
    super("Worker operation queue wait timed out");
    this.name = "OperationQueueTimeoutError";
  }
}
