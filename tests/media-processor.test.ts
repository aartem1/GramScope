import { EventEmitter } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import {
  buildFfmpegArgs,
  createFfmpegCommandRunner,
  createFfmpegProcessor,
  DECODER_MAX_PIXELS,
  evenlySpacedTimestamps,
  normalizeRequestedTimestamps,
  parseFfmpegDuration,
} from "@/media/ffmpeg-processor";
import { INLINE_MEDIA_MAX_BYTES } from "@/schemas/media";

describe("FFmpeg media processor contracts", () => {
  it("places eight samples inside, not on, a 90-second video's endpoints", () => {
    expect(evenlySpacedTimestamps(90, 8)).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
  });

  it("builds one spawn argument vector and never a shell command", () => {
    const args = buildFfmpegArgs("/tmp/in;touch-pwned.mp4", [1.25, 8.5], "/tmp/frames");
    const inputIndexes = args.flatMap((arg, index) => arg === "-i" ? [index] : []);
    expect(inputIndexes).toHaveLength(2);
    expect(args.filter((arg) => arg === "-max_pixels")).toHaveLength(2);
    for (const inputIndex of inputIndexes) {
      expect(args.slice(inputIndex - 2, inputIndex)).toEqual([
        "-max_pixels",
        String(DECODER_MAX_PIXELS),
      ]);
    }
    expect(args).toContain("/tmp/in;touch-pwned.mp4");
    expect(args.join(" ")).not.toContain("sh -c");
    expect(args.filter((arg) => arg === "-frames:v")).toHaveLength(2);
    expect(args.filter((arg) => arg === "-vf")).toHaveLength(2);
    expect(args).toContain("scale=1600:1600:force_original_aspect_ratio=decrease");
    expect(args.filter((arg) => arg === "-fs")).toHaveLength(2);
    expect(args.filter((arg) => arg === "4194304")).toHaveLength(2);
    expect(args).toContain("/tmp/frames/frame-0.jpg");
  });

  it("rejects non-positive duration and more than ten frames", () => {
    expect(() => evenlySpacedTimestamps(0, 8)).toThrow();
    expect(() => evenlySpacedTimestamps(90, 11)).toThrow();
  });

  it("rounds, sorts, and rejects duplicate or out-of-duration timestamps", () => {
    expect(normalizeRequestedTimestamps([8.0004, 1.0004, 5], 10)).toEqual([1, 5, 8]);
    expect(() => normalizeRequestedTimestamps([1.0001, 1.0004], 10)).toThrow();
    expect(() => normalizeRequestedTimestamps([11], 10)).toThrow();
  });

  it("parses one bounded FFmpeg duration diagnostic", () => {
    expect(parseFfmpegDuration("Duration: 01:02:03.500, start: 0.000000")).toBe(3723.5);
    expect(() => parseFfmpegDuration("Duration: N/A")).toThrow();
  });

  it("labels and combines all frames into one bounded JPEG", async () => {
    let runnerCalls = 0;
    const runner = async (_args: string[], directory: string) => {
      runnerCalls += 1;
      for (let i = 0; i < 3; i += 1) {
        await sharp({
          create: {
            width: 320,
            height: 180,
            channels: 3,
            background: `rgb(${180 + i * 20},180,180)`,
          },
        }).jpeg().toFile(`${directory}/frame-${i}.jpg`);
      }
    };
    const processor = createFfmpegProcessor({ run: runner });
    const result = await processor.contactSheet("/tmp/input.mp4", {
      timestampsSeconds: [1, 5, 9],
      maxBytes: INLINE_MEDIA_MAX_BYTES,
      maxLongEdge: 1600,
      deadline: new AbortController().signal,
    });

    expect(runnerCalls).toBe(1);
    expect(result.frameCount).toBe(3);
    expect(result.timestampsSeconds).toEqual([1, 5, 9]);
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.data.length).toBeLessThanOrEqual(INLINE_MEDIA_MAX_BYTES);
    expect(await sharp(result.data).metadata()).toMatchObject({ format: "jpeg" });
    const { data: pixels, info } = await sharp(result.data).raw().toBuffer({ resolveWithObject: true });
    const luminanceAt = (x: number, y: number) => {
      const offset = (y * info.width + x) * info.channels;
      return (pixels[offset]! + pixels[offset + 1]! + pixels[offset + 2]!) / 3;
    };
    expect(luminanceAt(700, 790)).toBeLessThan(luminanceAt(700, 100) - 50);
  });

  it("rejects an intermediate frame above the decoded dimension bound", async () => {
    const processor = createFfmpegProcessor({
      run: async (_args, directory) => {
        await sharp({
          create: { width: 4000, height: 3000, channels: 3, background: "white" },
        }).jpeg().toFile(`${directory}/frame-0.jpg`);
      },
    });

    await expect(processor.contactSheet("/tmp/input.mp4", {
      timestampsSeconds: [1],
      maxBytes: INLINE_MEDIA_MAX_BYTES,
      maxLongEdge: 1600,
      deadline: new AbortController().signal,
    })).rejects.toMatchObject({ code: "INLINE_LIMIT_EXCEEDED" });
  });

  it("kills and awaits the assembly process before removing decoded frames", async () => {
    const controller = new AbortController();
    let directory = "";
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    const spawnAssembly = vi.fn(() => child);
    const options = {
      run: async (_args: string[], outputDirectory: string) => {
        directory = outputDirectory;
        await sharp({
          create: { width: 320, height: 180, channels: 3, background: "white" },
        }).jpeg().toFile(`${outputDirectory}/frame-0.jpg`);
      },
      spawnAssembly,
    };
    const pending = createFfmpegProcessor(options).contactSheet("/tmp/input.mp4", {
      timestampsSeconds: [1],
      maxBytes: INLINE_MEDIA_MAX_BYTES,
      maxLongEdge: 1600,
      deadline: controller.signal,
    });

    await vi.waitFor(() => expect(spawnAssembly).toHaveBeenCalledOnce());
    expect(spawnAssembly).toHaveBeenCalledWith(
      process.execPath,
      [
        expect.stringMatching(/contact-sheet-worker\.mjs$/),
        directory,
        `${directory}/contact-sheet.jpg`,
        expect.any(String),
      ],
      { stdio: ["ignore", "pipe", "pipe"], shell: false },
    );
    controller.abort();
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    await expect(access(directory)).resolves.toBeUndefined();

    let settled = false;
    void pending.finally(() => { settled = true; }).catch(() => undefined);
    await Promise.resolve();
    expect(settled).toBe(false);

    child.emit("close", null);
    await expect(pending).rejects.toMatchObject({ code: "PROCESSING_TIMEOUT" });
    await expect(access(directory)).rejects.toThrow();
  });

  it("accepts real standard 4K input through the bounded decoder", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gramscope-4k-"));
    const inputPath = join(directory, "standard-4k.mp4");
    const command = createFfmpegCommandRunner();
    try {
      await command([
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "lavfi", "-i", "color=size=3840x2160:rate=1:duration=1",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        inputPath,
      ], new AbortController().signal);
      const result = await createFfmpegProcessor().contactSheet(inputPath, {
        timestampsSeconds: [0],
        maxBytes: INLINE_MEDIA_MAX_BYTES,
        maxLongEdge: 1600,
        deadline: new AbortController().signal,
      });
      expect(result.frameCount).toBe(1);
      expect(result.mimeType).toBe("image/jpeg");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("rejects a real image whose declared dimensions exceed the decoder pixel cap", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gramscope-hostile-dimensions-"));
    const inputPath = join(directory, "oversized.jpg");
    try {
      await sharp({
        create: { width: 5000, height: 3000, channels: 3, background: "white" },
      }).jpeg().toFile(inputPath);
      await expect(createFfmpegProcessor().contactSheet(inputPath, {
        timestampsSeconds: [0],
        maxBytes: INLINE_MEDIA_MAX_BYTES,
        maxLongEdge: 1600,
        deadline: new AbortController().signal,
      })).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("caps stderr at 8 KiB and spawns FFmpeg without a shell", async () => {
    const child = new EventEmitter() as EventEmitter & {
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    const spawnProcess = vi.fn(() => child);
    const command = createFfmpegCommandRunner(spawnProcess);
    const pending = command(["-version"], new AbortController().signal);
    child.stderr.write(Buffer.alloc(9 * 1024, 65));
    child.emit("close", 0);

    await expect(pending).resolves.toHaveLength(8 * 1024);
    expect(spawnProcess).toHaveBeenCalledWith(expect.any(String), ["-version"], {
      stdio: ["ignore", "ignore", "pipe"],
      shell: false,
    });
  });

  it("sends SIGKILL on abort and waits for process close before rejecting", async () => {
    const child = new EventEmitter() as EventEmitter & {
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    const command = createFfmpegCommandRunner(() => child);
    const controller = new AbortController();
    const pending = command(["-version"], controller.signal);
    let settled = false;
    void pending.finally(() => { settled = true; }).catch(() => undefined);

    controller.abort();
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(settled).toBe(false);
    child.emit("close", null);
    await expect(pending).rejects.toMatchObject({ code: "PROCESSING_TIMEOUT" });
  });
});
