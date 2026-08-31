import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  buildFfmpegArgs,
  createFfmpegProcessor,
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
    expect(args.filter((arg) => arg === "-i")).toHaveLength(2);
    expect(args).toContain("/tmp/in;touch-pwned.mp4");
    expect(args.join(" ")).not.toContain("sh -c");
    expect(args.filter((arg) => arg === "-frames:v")).toHaveLength(2);
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
        }).png().toFile(`${directory}/frame-${i}.png`);
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
});
