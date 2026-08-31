import { access, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DerivativeCache,
  derivativeKey,
  singleFlight,
  withVideoPermit,
  type CachedDerivative,
} from "@/media/cache";

const directories: string[] = [];

async function tempFile(bytes: number): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "gramscope-cache-test-"));
  directories.push(directory);
  const path = join(directory, "derivative.jpg");
  await writeFile(path, Buffer.alloc(bytes));
  return path;
}

function derivative(path: string, bytes: number): CachedDerivative {
  return {
    path,
    bytes,
    mimeType: "image/jpeg",
    width: 320,
    height: 180,
  };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("DerivativeCache", () => {
  it("expires at 30 minutes and deletes the exact cached file", async () => {
    let now = 0;
    const cache = new DerivativeCache({
      maxBytes: 256,
      ttlMs: 30 * 60_000,
      now: () => now,
    });
    const file = await tempFile(100);
    await cache.set("a", derivative(file, 100));

    now = 30 * 60_000 + 1;

    expect(await cache.get("a")).toBeUndefined();
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("evicts least recently used files until the byte total fits", async () => {
    const cache = new DerivativeCache({ maxBytes: 200, ttlMs: 1_000_000 });
    const a = await tempFile(100);
    const b = await tempFile(100);
    const c = await tempFile(100);
    await cache.set("a", derivative(a, 100));
    await cache.set("b", derivative(b, 100));
    await cache.get("a");

    await cache.set("c", derivative(c, 100));

    expect(await cache.get("a")).toBeDefined();
    expect(await cache.get("b")).toBeUndefined();
    expect(await cache.get("c")).toBeDefined();
    await expect(access(b)).rejects.toThrow();
  });

  it("deletes an entry that cannot fit by itself", async () => {
    const cache = new DerivativeCache({ maxBytes: 99, ttlMs: 1_000_000 });
    const file = await tempFile(100);

    await cache.set("too-large", derivative(file, 100));

    expect(await cache.get("too-large")).toBeUndefined();
    await expect(access(file)).rejects.toThrow();
  });

  it("rejects an invalid measured byte count without corrupting cache accounting", async () => {
    const cache = new DerivativeCache({ maxBytes: 200, ttlMs: 1_000_000 });
    const invalid = await tempFile(10);
    const valid = await tempFile(100);

    await cache.set("invalid", derivative(invalid, -1));
    await expect(access(invalid)).rejects.toThrow();
    await cache.set("valid", derivative(valid, 100));

    expect(await cache.get("invalid")).toBeUndefined();
    expect(await cache.get("valid")).toBeDefined();
  });

  it("forgets a file removed outside the cache without deleting unrelated files", async () => {
    const { rm } = await import("node:fs/promises");
    const cache = new DerivativeCache({ maxBytes: 256, ttlMs: 1_000_000 });
    const file = await tempFile(100);
    const sibling = join(file, "..", "unrelated.txt");
    await writeFile(sibling, "keep");
    await cache.set("missing", derivative(file, 100));
    await rm(file);

    expect(await cache.get("missing")).toBeUndefined();
    await expect(access(sibling)).resolves.toBeUndefined();
  });

  it("invalidates and deletes a cached file whose measured size changed", async () => {
    const cache = new DerivativeCache({ maxBytes: 256, ttlMs: 1_000_000 });
    const file = await tempFile(100);
    await cache.set("changed", derivative(file, 100));
    await writeFile(file, Buffer.alloc(101));

    expect(await cache.get("changed")).toBeUndefined();
    await expect(access(file)).rejects.toThrow();
  });

  it("keeps byte accounting correct after two concurrent misses of one removed file", async () => {
    const cache = new DerivativeCache({ maxBytes: 200, ttlMs: 1_000_000 });
    const missing = await tempFile(100);
    await cache.set("missing", derivative(missing, 100));
    await rm(missing);

    await Promise.all([cache.get("missing"), cache.get("missing")]);

    const b = await tempFile(100);
    const c = await tempFile(100);
    const d = await tempFile(100);
    await cache.set("b", derivative(b, 100));
    await cache.set("c", derivative(c, 100));
    await cache.set("d", derivative(d, 100));
    const remaining = await Promise.all([cache.get("b"), cache.get("c"), cache.get("d")]);
    expect(remaining.filter((value) => value !== undefined)).toHaveLength(2);
    expect(await cache.get("b")).toBeUndefined();
    await cache.clear();
  });

  it("linearizes concurrent same-key replacement and deletes the losing file exactly once", async () => {
    const deleted: string[] = [];
    const cache = new DerivativeCache({
      maxBytes: 200,
      ttlMs: 1_000_000,
      remove: async (path: string) => {
        deleted.push(path);
        await rm(path, { force: true });
      },
    });
    const loser = await tempFile(100);
    const winner = await tempFile(100);

    await Promise.all([
      cache.set("same", derivative(loser, 100)),
      cache.set("same", derivative(winner, 100)),
    ]);

    expect(await cache.get("same")).toMatchObject({ path: winner });
    expect(deleted.filter((path) => path === loser)).toHaveLength(1);
    expect(deleted.filter((path) => path === winner)).toHaveLength(0);
    await expect(access(loser)).rejects.toThrow();
    await expect(access(winner)).resolves.toBeUndefined();

    await cache.clear();
    expect(deleted.filter((path) => path === loser)).toHaveLength(1);
    expect(deleted.filter((path) => path === winner)).toHaveLength(1);
  });

  it("orders clear before a concurrent set and never lets clear delete the newer entry", async () => {
    let releaseOld!: () => void;
    let markOldRemoval!: () => void;
    const oldRemovalStarted = new Promise<void>((resolve) => { markOldRemoval = resolve; });
    const oldRemovalGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    const removed: string[] = [];
    const old = await tempFile(100);
    const fresh = await tempFile(100);
    const cache = new DerivativeCache({
      maxBytes: 200,
      ttlMs: 1_000_000,
      remove: async (path: string) => {
        removed.push(path);
        if (path === old) {
          markOldRemoval();
          await oldRemovalGate;
        }
        await rm(path, { force: true });
      },
    });
    await cache.set("same", derivative(old, 100));

    const clearing = cache.clear();
    await oldRemovalStarted;
    const setting = cache.set("same", derivative(fresh, 100));
    releaseOld();
    await Promise.all([clearing, setting]);

    expect(await cache.get("same")).toMatchObject({ path: fresh });
    expect(removed.filter((path) => path === old)).toHaveLength(1);
    expect(removed.filter((path) => path === fresh)).toHaveLength(0);
    await cache.clear();
  });

  it("returns metadata copies so callers cannot mutate cached timestamps", async () => {
    const cache = new DerivativeCache({ maxBytes: 256, ttlMs: 1_000_000 });
    const file = await tempFile(100);
    await cache.set("copy", {
      ...derivative(file, 100),
      frameCount: 2,
      timestampsSeconds: [1, 2],
    });

    const first = await cache.get("copy");
    first!.timestampsSeconds![0] = 99;

    expect((await cache.get("copy"))?.timestampsSeconds).toEqual([1, 2]);
  });

  it("clears and deletes every owned derivative file", async () => {
    const cache = new DerivativeCache({ maxBytes: 256, ttlMs: 1_000_000 });
    const a = await tempFile(100);
    const b = await tempFile(100);
    await cache.set("a", derivative(a, 100));
    await cache.set("b", derivative(b, 100));

    await cache.clear();

    await expect(access(a)).rejects.toThrow();
    await expect(access(b)).rejects.toThrow();
  });
});

describe("derivative work coordination", () => {
  it("derives a stable opaque key from normalized representation parameters", () => {
    const first = derivativeKey({
      mediaId: "med_123",
      mode: "frames",
      timestampsSeconds: [1, 5, 9],
      maxFrames: 3,
      processorVersion: "contact-sheet-v1",
    });
    const same = derivativeKey({
      mediaId: "med_123",
      mode: "frames",
      timestampsSeconds: [1, 5, 9],
      maxFrames: 3,
      processorVersion: "contact-sheet-v1",
    });
    const changed = derivativeKey({
      mediaId: "med_123",
      mode: "frames",
      timestampsSeconds: [1, 5, 10],
      maxFrames: 3,
      processorVersion: "contact-sheet-v1",
    });

    expect(first).toBe(same);
    expect(first).not.toBe(changed);
    expect(first).not.toContain("med_123");
  });

  it("runs identical work once and different keys independently", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sameWork = vi.fn(async () => {
      await gate;
      return 42;
    });
    const first = singleFlight("same", sameWork);
    const second = singleFlight("same", sameWork);
    const other = singleFlight("other", async () => 7);

    await expect(other).resolves.toBe(7);
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([42, 42]);
    expect(sameWork).toHaveBeenCalledTimes(1);
  });

  it("allows a failed key to be attempted again", async () => {
    await expect(singleFlight("retry", async () => {
      throw new Error("first failure");
    })).rejects.toThrow("first failure");

    await expect(singleFlight("retry", async () => 42)).resolves.toBe(42);
  });

  it("runs video work one at a time in FIFO order without blocking unrelated work", async () => {
    let active = 0;
    let peak = 0;
    const started: number[] = [];
    const releases: Array<() => void> = [];
    const video = (id: number) => withVideoPermit(async () => {
      active += 1;
      peak = Math.max(peak, active);
      started.push(id);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return id;
    });

    const first = video(1);
    const second = video(2);
    const third = video(3);
    const image = Promise.resolve("image-ready");

    await vi.waitFor(() => expect(started).toEqual([1]));
    await expect(image).resolves.toBe("image-ready");
    releases.shift()!();
    await vi.waitFor(() => expect(started).toEqual([1, 2]));
    releases.shift()!();
    await vi.waitFor(() => expect(started).toEqual([1, 2, 3]));
    releases.shift()!();

    await expect(Promise.all([first, second, third])).resolves.toEqual([1, 2, 3]);
    expect(peak).toBe(1);
  });

  it("releases the video permit after work rejects", async () => {
    await expect(withVideoPermit(async () => {
      throw new Error("processor failed");
    })).rejects.toThrow("processor failed");

    await expect(withVideoPermit(async () => 42)).resolves.toBe(42);
  });
});
