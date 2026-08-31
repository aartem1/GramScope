import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import sharp from "sharp";
import { GramScopeError, mediaError } from "../errors/taxonomy";
import { MAX_FRAMES } from "../schemas/media";
import { normalizeImage, runSharpOperation } from "./image";
import type {
  ContactSheetRequest,
  ContactSheetResult,
  MediaProcessor,
} from "./processor";

const MAX_DIAGNOSTIC_BYTES = 8 * 1024;
export const INTERMEDIATE_FRAME_MAX_LONG_EDGE = 1600;
export const INTERMEDIATE_FRAME_MAX_BYTES = 4 * 1024 * 1024;
const INTERMEDIATE_FRAME_MAX_PIXELS = INTERMEDIATE_FRAME_MAX_LONG_EDGE ** 2;

export type FrameRunner = (
  args: string[],
  outputDirectory: string,
  signal: AbortSignal,
) => Promise<void>;

export type FfmpegChild = {
  stderr: {
    on(event: "data", listener: (value: Buffer | string) => void): unknown;
  };
  kill(signal: "SIGKILL"): boolean;
  once(event: "error", listener: () => void): unknown;
  once(event: "close", listener: (code: number | null) => void): unknown;
};

export type SpawnFfmpeg = (
  binary: string,
  args: string[],
  options: { stdio: ["ignore", "ignore", "pipe"]; shell: false },
) => FfmpegChild;

export type FfmpegCommandRunner = (args: string[], signal: AbortSignal) => Promise<string>;

export type ContactSheetAssembler = (
  outputDirectory: string,
  request: ContactSheetRequest,
) => Promise<ContactSheetResult>;

export function evenlySpacedTimestamps(durationSeconds: number, count: number): number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw mediaError("UNSUPPORTED_MEDIA", "Video duration is unavailable", false);
  }
  if (!Number.isInteger(count) || count < 1 || count > MAX_FRAMES) {
    throw new GramScopeError("INVALID_INPUT", `Frame count must be 1..${MAX_FRAMES}`);
  }
  return Array.from({ length: count }, (_, index) =>
    Number((durationSeconds * (index + 1) / (count + 1)).toFixed(3)));
}

export function normalizeRequestedTimestamps(
  values: number[],
  durationSeconds: number,
): number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw mediaError("UNSUPPORTED_MEDIA", "Video duration is unavailable", false);
  }
  if (values.length < 1 || values.length > MAX_FRAMES) {
    throw new GramScopeError("INVALID_INPUT", `Frame count must be 1..${MAX_FRAMES}`);
  }
  const rounded = values.map((value) => Math.round(value * 1000) / 1000);
  if (rounded.some((value) => !Number.isFinite(value))) {
    throw new GramScopeError("INVALID_INPUT", "timestamps_seconds must be finite");
  }
  if (new Set(rounded).size !== rounded.length) {
    throw new GramScopeError(
      "INVALID_INPUT",
      "timestamps_seconds must be unique after millisecond rounding",
    );
  }
  if (rounded.some((value) => value < 0 || value > durationSeconds)) {
    throw new GramScopeError(
      "INVALID_INPUT",
      `timestamps_seconds must be within the video duration ${durationSeconds}`,
    );
  }
  return rounded.sort((a, b) => a - b);
}

export function parseFfmpegDuration(stderr: string): number {
  const match = /Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
  if (!match) {
    throw mediaError("UNSUPPORTED_MEDIA", "Video duration is unavailable", false);
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const secondsPart = Number(match[3]);
  const seconds = hours * 3600 + minutes * 60 + secondsPart;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw mediaError("UNSUPPORTED_MEDIA", "Video duration is unavailable", false);
  }
  return seconds;
}

export function buildFfmpegArgs(
  inputPath: string,
  timestamps: number[],
  outputDirectory: string,
): string[] {
  const inputs = timestamps.flatMap((timestamp) => ["-ss", timestamp.toFixed(3), "-i", inputPath]);
  const outputs = timestamps.flatMap((_, index) => [
    "-map",
    `${index}:v:0`,
    "-vf",
    `scale=${INTERMEDIATE_FRAME_MAX_LONG_EDGE}:${INTERMEDIATE_FRAME_MAX_LONG_EDGE}:force_original_aspect_ratio=decrease`,
    "-frames:v",
    "1",
    "-q:v",
    "5",
    "-fs",
    String(INTERMEDIATE_FRAME_MAX_BYTES),
    "-f",
    "image2",
    `${outputDirectory}/frame-${index}.jpg`,
  ]);
  return ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...inputs, ...outputs];
}

function processingTimeout(): GramScopeError {
  return mediaError("PROCESSING_TIMEOUT", "Video processing exceeded its deadline", true);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw processingTimeout();
}

const defaultSpawnFfmpeg: SpawnFfmpeg = (binary, args, options) =>
  spawn(binary, args, options) as unknown as FfmpegChild;

export function createFfmpegCommandRunner(
  spawnProcess: SpawnFfmpeg = defaultSpawnFfmpeg,
): FfmpegCommandRunner {
  return async (args, signal) => {
    throwIfAborted(signal);
    if (!ffmpegPath) {
      throw mediaError("UNSUPPORTED_MEDIA", "Video processing is unavailable", false);
    }
    const binary = ffmpegPath;
    return new Promise<string>((resolve, reject) => {
      const child = spawnProcess(binary, args, {
        stdio: ["ignore", "ignore", "pipe"],
        shell: false,
      });
      const diagnostic: Buffer[] = [];
      let diagnosticBytes = 0;
      let aborted = false;
      let settled = false;

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(Buffer.concat(diagnostic, diagnosticBytes).toString("utf8"));
      };
      const abort = () => {
        aborted = true;
        child.kill("SIGKILL");
      };

      signal.addEventListener("abort", abort, { once: true });
      child.stderr.on("data", (value: Buffer | string) => {
        if (diagnosticBytes >= MAX_DIAGNOSTIC_BYTES) return;
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        const bounded = chunk.subarray(0, MAX_DIAGNOSTIC_BYTES - diagnosticBytes);
        diagnostic.push(bounded);
        diagnosticBytes += bounded.length;
      });
      child.once("error", () => {
        finish(mediaError("UNSUPPORTED_MEDIA", "Video processing is unavailable", false));
      });
      child.once("close", (code) => {
        if (aborted || signal.aborted) {
          finish(processingTimeout());
        } else if (code !== 0) {
          finish(mediaError("UNSUPPORTED_MEDIA", "Video frames could not be decoded", false));
        } else {
          finish();
        }
      });
      if (signal.aborted) abort();
    });
  };
}

function timestampLabel(seconds: number, width: number): Buffer {
  const minutes = Math.floor(seconds / 60);
  const rest = (seconds % 60).toFixed(1).padStart(4, "0");
  return Buffer.from(
    `<svg width="${width}" height="28"><rect width="100%" height="28" fill="rgba(0,0,0,.65)"/><text x="8" y="20" fill="white" font-family="sans-serif" font-size="16">${minutes}:${rest}</text></svg>`,
  );
}

async function buildContactSheet(
  directory: string,
  request: ContactSheetRequest,
): Promise<ContactSheetResult> {
  const frameCount = request.timestampsSeconds.length;
  if (frameCount < 1 || frameCount > MAX_FRAMES) {
    throw new GramScopeError("INVALID_INPUT", `Frame count must be 1..${MAX_FRAMES}`);
  }
  const columns = Math.ceil(Math.sqrt(frameCount));
  const rows = Math.ceil(frameCount / columns);
  const cellSize = Math.max(1, Math.floor(request.maxLongEdge / Math.max(columns, rows)));
  const width = columns * cellSize;
  const height = rows * cellSize;
  const overlays: Array<{ input: Buffer; left: number; top: number }> = [];

  for (let index = 0; index < frameCount; index += 1) {
    throwIfAborted(request.deadline);
    const framePath = join(directory, `frame-${index}.jpg`);
    const frameStats = await stat(framePath);
    if (frameStats.size > INTERMEDIATE_FRAME_MAX_BYTES) {
      throw mediaError("INLINE_LIMIT_EXCEEDED", "Decoded video frame exceeds its byte limit", false);
    }
    const metadataPipeline = sharp(framePath, {
      failOn: "warning",
      limitInputPixels: INTERMEDIATE_FRAME_MAX_PIXELS,
    });
    let metadata: Awaited<ReturnType<typeof metadataPipeline.metadata>>;
    try {
      metadata = await runSharpOperation(
        metadataPipeline,
        (pipeline) => pipeline.metadata(),
        request.deadline,
      );
    } catch (error) {
      if (error instanceof GramScopeError) throw error;
      throw mediaError("INLINE_LIMIT_EXCEEDED", "Decoded video frame exceeds its dimension limit", false);
    }
    if (
      !metadata.width ||
      !metadata.height ||
      Math.max(metadata.width, metadata.height) > INTERMEDIATE_FRAME_MAX_LONG_EDGE
    ) {
      throw mediaError("INLINE_LIMIT_EXCEEDED", "Decoded video frame exceeds its dimension limit", false);
    }
    const framePipeline = sharp(framePath, {
      failOn: "warning",
      limitInputPixels: INTERMEDIATE_FRAME_MAX_PIXELS,
    })
      .rotate()
      .resize({ width: cellSize, height: cellSize, fit: "cover" })
      .jpeg({ quality: 90 });
    const cell = await runSharpOperation(
      framePipeline,
      (pipeline) => pipeline.toBuffer(),
      request.deadline,
    );
    const left = (index % columns) * cellSize;
    const top = Math.floor(index / columns) * cellSize;
    overlays.push({ input: cell, left, top });
    overlays.push({
      input: timestampLabel(request.timestampsSeconds[index]!, cellSize),
      left,
      top: top + Math.max(0, cellSize - 28),
    });
  }

  throwIfAborted(request.deadline);
  const compositePipeline = sharp({
    create: { width, height, channels: 3, background: "black" },
  }).composite(overlays).png();
  const canvas = await runSharpOperation(
    compositePipeline,
    (pipeline) => pipeline.toBuffer(),
    request.deadline,
  );
  throwIfAborted(request.deadline);
  const result = await normalizeImage(canvas, {
    maxBytes: request.maxBytes,
    maxLongEdge: request.maxLongEdge,
    sourceMimeType: "image/x-contact-sheet-source",
    deadline: request.deadline,
  });
  throwIfAborted(request.deadline);
  if (result.mimeType !== "image/jpeg") {
    throw mediaError("INLINE_LIMIT_EXCEEDED", "Contact sheet could not be encoded as JPEG", false);
  }
  return {
    ...result,
    mimeType: "image/jpeg",
    frameCount,
    timestampsSeconds: [...request.timestampsSeconds],
  };
}

async function raceWithDeadline<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, result?: T) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (error !== undefined) reject(error);
      else resolve(result as T);
    };
    const abort = () => finish(processingTimeout());
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    if (settled) return;
    try {
      start().then(
        (result) => finish(undefined, result),
        (error: unknown) => finish(error),
      );
    } catch (error) {
      finish(error);
    }
  });
}

export function createFfmpegProcessor(options: {
  run?: FrameRunner;
  spawn?: SpawnFfmpeg;
  assemble?: ContactSheetAssembler;
} = {}): MediaProcessor {
  const command = createFfmpegCommandRunner(options.spawn);
  const run = options.run ?? (async (args: string[], _directory: string, signal: AbortSignal) => {
    await command(args, signal);
  });
  const assemble = options.assemble ?? buildContactSheet;
  return {
    async probeDuration(inputPath, deadline) {
      const stderr = await command(
        ["-hide_banner", "-nostdin", "-i", inputPath, "-t", "0", "-f", "null", "-"],
        deadline,
      );
      return parseFfmpegDuration(stderr);
    },
    async contactSheet(inputPath, request) {
      throwIfAborted(request.deadline);
      const directory = await mkdtemp(join(tmpdir(), "gramscope-frames-"));
      try {
        const args = buildFfmpegArgs(inputPath, request.timestampsSeconds, directory);
        await run(args, directory, request.deadline);
        throwIfAborted(request.deadline);
        return await raceWithDeadline(() => assemble(directory, request), request.deadline);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

export const mediaProcessor: MediaProcessor = createFfmpegProcessor();
