import { createHash } from "node:crypto";
import { lstat, rm } from "node:fs/promises";
import { mediaError } from "../errors/taxonomy";

export type CachedDerivative = {
  path: string;
  bytes: number;
  mimeType: string;
  width: number;
  height: number;
  frameCount?: number;
  timestampsSeconds?: number[];
};

type Entry = {
  value: CachedDerivative;
  expiresAt: number;
  lastUsed: number;
};

function copyDerivative(value: CachedDerivative): CachedDerivative {
  return {
    ...value,
    ...(value.timestampsSeconds
      ? { timestampsSeconds: [...value.timestampsSeconds] }
      : {}),
  };
}

export class DerivativeCache {
  private readonly entries = new Map<string, Entry>();
  private totalBytes = 0;
  private sequence = 0;
  private mutationTail = Promise.resolve();

  constructor(private readonly options: {
    maxBytes: number;
    ttlMs: number;
    now?: () => number;
    remove?: (path: string) => Promise<void>;
  }) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private runExclusive<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => { release = resolve; });
    return previous.then(work).finally(release);
  }

  private async deleteFile(path: string): Promise<void> {
    await (this.options.remove ?? ((target: string) => rm(target, { force: true })))(path);
  }

  private async removeEntry(
    key: string,
    expected: Entry,
    preservePath?: string,
  ): Promise<boolean> {
    if (this.entries.get(key) !== expected) return false;
    this.entries.delete(key);
    this.totalBytes -= expected.value.bytes;
    if (expected.value.path !== preservePath) {
      await this.deleteFile(expected.value.path);
    }
    return true;
  }

  async get(key: string): Promise<CachedDerivative | undefined> {
    return this.runExclusive(() => this.getLocked(key));
  }

  private async getLocked(key: string): Promise<CachedDerivative | undefined> {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      await this.removeEntry(key, entry);
      return undefined;
    }
    let file;
    try {
      file = await lstat(entry.value.path);
    } catch {
      await this.removeEntry(key, entry);
      return undefined;
    }
    if (!file.isFile() || file.size !== entry.value.bytes) {
      await this.removeEntry(key, entry);
      return undefined;
    }
    entry.lastUsed = ++this.sequence;
    return copyDerivative(entry.value);
  }

  async set(key: string, value: CachedDerivative): Promise<void> {
    return this.runExclusive(() => this.setLocked(key, value));
  }

  private async setLocked(key: string, value: CachedDerivative): Promise<void> {
    if (
      !Number.isSafeInteger(value.bytes) ||
      value.bytes < 0 ||
      value.bytes > this.options.maxBytes
    ) {
      await this.deleteFile(value.path);
      return;
    }
    const replaced = this.entries.get(key);
    if (replaced) await this.removeEntry(key, replaced, value.path);
    this.entries.set(key, {
      value: copyDerivative(value),
      expiresAt: this.now() + this.options.ttlMs,
      lastUsed: ++this.sequence,
    });
    this.totalBytes += value.bytes;
    while (this.totalBytes > this.options.maxBytes) {
      let oldestKey: string | undefined;
      let oldestUse = Number.POSITIVE_INFINITY;
      for (const [candidateKey, entry] of this.entries) {
        if (entry.lastUsed < oldestUse) {
          oldestKey = candidateKey;
          oldestUse = entry.lastUsed;
        }
      }
      if (oldestKey === undefined) break;
      const oldest = this.entries.get(oldestKey);
      if (oldest) await this.removeEntry(oldestKey, oldest);
    }
  }

  async clear(): Promise<void> {
    return this.runExclusive(async () => {
      for (const [key, entry] of [...this.entries.entries()]) {
        await this.removeEntry(key, entry);
      }
    });
  }
}

export const derivativeCache = new DerivativeCache({
  maxBytes: 256 * 1024 * 1024,
  ttlMs: 30 * 60_000,
});

export function derivativeKey(input: {
  mediaId: string;
  mode: string;
  timestampsSeconds?: number[];
  maxFrames: number;
  processorVersion: string;
}): string {
  const canonical = JSON.stringify({
    media_id: input.mediaId,
    mode: input.mode,
    timestamps_seconds: input.timestampsSeconds ?? [],
    max_frames: input.maxFrames,
    processor_version: input.processorVersion,
  });
  return createHash("sha256").update(canonical).digest("base64url");
}

const flights = new Map<string, Promise<unknown>>();

export function singleFlight<T>(key: string, work: () => Promise<T>): Promise<T> {
  const existing = flights.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const running = work().finally(() => flights.delete(key));
  flights.set(key, running);
  return running;
}

type VideoWaiter = {
  work: () => Promise<unknown>;
  signal?: AbortSignal;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  started: boolean;
  abort?: () => void;
};

const videoQueue: VideoWaiter[] = [];
let videoActive = false;

function videoPermitTimeout(): Error {
  return mediaError("PROCESSING_TIMEOUT", "Video processing exceeded its deadline", true);
}

function removeAbortListener(waiter: VideoWaiter): void {
  if (waiter.signal && waiter.abort) {
    waiter.signal.removeEventListener("abort", waiter.abort);
  }
}

function drainVideoQueue(): void {
  if (videoActive) return;
  const waiter = videoQueue.shift();
  if (!waiter) return;
  if (waiter.signal?.aborted) {
    removeAbortListener(waiter);
    waiter.reject(videoPermitTimeout());
    drainVideoQueue();
    return;
  }

  waiter.started = true;
  removeAbortListener(waiter);
  videoActive = true;
  void Promise.resolve()
    .then(waiter.work)
    .then(waiter.resolve, waiter.reject)
    .finally(() => {
      videoActive = false;
      drainVideoQueue();
    });
}

export function withVideoPermit<T>(
  work: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const waiter: VideoWaiter = {
      work,
      ...(signal ? { signal } : {}),
      resolve: (value) => resolve(value as T),
      reject,
      started: false,
    };
    const abort = () => {
      if (waiter.started) return;
      const index = videoQueue.indexOf(waiter);
      if (index === -1) return;
      videoQueue.splice(index, 1);
      removeAbortListener(waiter);
      reject(videoPermitTimeout());
      drainVideoQueue();
    };
    waiter.abort = abort;
    videoQueue.push(waiter);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    else drainVideoQueue();
  });
}
