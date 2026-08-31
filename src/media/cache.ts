import { createHash } from "node:crypto";
import { lstat, rm } from "node:fs/promises";

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

  constructor(private readonly options: {
    maxBytes: number;
    ttlMs: number;
    now?: () => number;
  }) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private async remove(key: string, preservePath?: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.totalBytes -= entry.value.bytes;
    if (entry.value.path !== preservePath) {
      await rm(entry.value.path, { force: true });
    }
  }

  async get(key: string): Promise<CachedDerivative | undefined> {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      await this.remove(key);
      return undefined;
    }
    let file;
    try {
      file = await lstat(entry.value.path);
    } catch {
      this.entries.delete(key);
      this.totalBytes -= entry.value.bytes;
      return undefined;
    }
    if (!file.isFile() || file.size !== entry.value.bytes) {
      await this.remove(key);
      return undefined;
    }
    entry.lastUsed = ++this.sequence;
    return copyDerivative(entry.value);
  }

  async set(key: string, value: CachedDerivative): Promise<void> {
    if (
      !Number.isSafeInteger(value.bytes) ||
      value.bytes < 0 ||
      value.bytes > this.options.maxBytes
    ) {
      await rm(value.path, { force: true });
      return;
    }
    await this.remove(key, value.path);
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
      await this.remove(oldestKey);
    }
  }

  async clear(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((key) => this.remove(key)));
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

let videoTail = Promise.resolve();

export async function withVideoPermit<T>(work: () => Promise<T>): Promise<T> {
  const previous = videoTail;
  let release!: () => void;
  videoTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}
