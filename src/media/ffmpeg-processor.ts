import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import { GramScopeError, mediaError } from "../errors/taxonomy";
import { MAX_FRAMES } from "../schemas/media";
import type {
  ContactSheetRequest,
  ContactSheetResult,
  MediaProcessor,
} from "./processor";

const MAX_DIAGNOSTIC_BYTES = 8 * 1024;
export const INTERMEDIATE_FRAME_MAX_LONG_EDGE = 1600;
export const INTERMEDIATE_FRAME_MAX_BYTES = 4 * 1024 * 1024;
// 4096×2304 admits UHD/DCI 4K with modest aspect-ratio headroom, while
// rejecting dimensions that can amplify a tiny compressed input dangerously.
export const DECODER_MAX_PIXELS = 4096 * 2304;

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

export type ContactSheetChild = {
  stdout: {
    on(event: "data", listener: (value: Buffer | string) => void): unknown;
  };
  stderr: {
    on(event: "data", listener: (value: Buffer | string) => void): unknown;
  };
  kill(signal: "SIGKILL"): boolean;
  once(event: "error", listener: () => void): unknown;
  once(event: "close", listener: (code: number | null) => void): unknown;
};

export type SpawnContactSheet = (
  binary: string,
  args: string[],
  options: { stdio: ["ignore", "pipe", "pipe"]; shell: false },
) => ContactSheetChild;

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
  const inputs = timestamps.flatMap((timestamp) => [
    "-ss",
    timestamp.toFixed(3),
    "-max_pixels",
    String(DECODER_MAX_PIXELS),
    "-i",
    inputPath,
  ]);
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

const defaultSpawnContactSheet: SpawnContactSheet = (binary, args, options) =>
  spawn(binary, args, options) as unknown as ContactSheetChild;

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

function collectBounded(
  source: ContactSheetChild["stdout"] | ContactSheetChild["stderr"],
): { chunks: Buffer[]; size: () => number } {
  const chunks: Buffer[] = [];
  let bytes = 0;
  source.on("data", (value: Buffer | string) => {
    if (bytes >= MAX_DIAGNOSTIC_BYTES) return;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const bounded = chunk.subarray(0, MAX_DIAGNOSTIC_BYTES - bytes);
    chunks.push(bounded);
    bytes += bounded.length;
  });
  return { chunks, size: () => bytes };
}

export function createContactSheetAssembler(
  spawnProcess: SpawnContactSheet = defaultSpawnContactSheet,
): ContactSheetAssembler {
  return async (directory, request) => {
    throwIfAborted(request.deadline);
    const frameCount = request.timestampsSeconds.length;
    if (frameCount < 1 || frameCount > MAX_FRAMES) {
      throw new GramScopeError("INVALID_INPUT", `Frame count must be 1..${MAX_FRAMES}`);
    }
    const outputPath = join(directory, "contact-sheet.jpg");
    const workerPath = join(process.cwd(), "src/media/contact-sheet-worker.mjs");
    const child = spawnProcess(process.execPath, [
      workerPath,
      directory,
      outputPath,
      JSON.stringify({
        timestampsSeconds: request.timestampsSeconds,
        maxBytes: request.maxBytes,
        maxLongEdge: request.maxLongEdge,
        intermediateFrameMaxBytes: INTERMEDIATE_FRAME_MAX_BYTES,
        intermediateFrameMaxLongEdge: INTERMEDIATE_FRAME_MAX_LONG_EDGE,
      }),
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const output = collectBounded(child.stdout);
    collectBounded(child.stderr);

    await new Promise<void>((resolve, reject) => {
      let aborted = false;
      let spawnFailed = false;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        request.deadline.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => {
        aborted = true;
        child.kill("SIGKILL");
      };
      request.deadline.addEventListener("abort", abort, { once: true });
      child.once("error", () => {
        spawnFailed = true;
      });
      child.once("close", (code) => {
        if (aborted || request.deadline.aborted) {
          finish(processingTimeout());
        } else if (spawnFailed) {
          finish(mediaError("UNSUPPORTED_MEDIA", "Contact-sheet processing is unavailable", false));
        } else if (code !== 0) {
          finish(mediaError("INLINE_LIMIT_EXCEEDED", "Contact sheet could not be encoded", false));
        } else {
          finish();
        }
      });
      if (request.deadline.aborted) abort();
    });

    throwIfAborted(request.deadline);
    const resultStats = await stat(outputPath);
    if (resultStats.size > request.maxBytes) {
      throw mediaError("INLINE_LIMIT_EXCEEDED", "Contact sheet exceeds its byte limit", false);
    }
    let data: Buffer;
    try {
      data = await readFile(outputPath, { signal: request.deadline });
    } catch (error) {
      if (request.deadline.aborted) throw processingTimeout();
      throw error;
    }
    throwIfAborted(request.deadline);
    let metadata: { width?: unknown; height?: unknown };
    try {
      metadata = JSON.parse(Buffer.concat(output.chunks, output.size()).toString("utf8")) as {
        width?: unknown;
        height?: unknown;
      };
    } catch {
      throw mediaError("INLINE_LIMIT_EXCEEDED", "Contact sheet metadata is invalid", false);
    }
    if (
      typeof metadata.width !== "number" ||
      typeof metadata.height !== "number" ||
      metadata.width < 1 ||
      metadata.height < 1 ||
      Math.max(metadata.width, metadata.height) > request.maxLongEdge
    ) {
      throw mediaError("INLINE_LIMIT_EXCEEDED", "Contact sheet dimensions are invalid", false);
    }
    return {
      data,
      mimeType: "image/jpeg",
      width: metadata.width,
      height: metadata.height,
      frameCount,
      timestampsSeconds: [...request.timestampsSeconds],
    };
  };
}

export function createFfmpegProcessor(options: {
  run?: FrameRunner;
  spawn?: SpawnFfmpeg;
  spawnAssembly?: SpawnContactSheet;
} = {}): MediaProcessor {
  const command = createFfmpegCommandRunner(options.spawn);
  const run = options.run ?? (async (args: string[], _directory: string, signal: AbortSignal) => {
    await command(args, signal);
  });
  const assemble = createContactSheetAssembler(options.spawnAssembly);
  return {
    async probeDuration(inputPath, deadline) {
      const stderr = await command(
        [
          "-hide_banner",
          "-nostdin",
          "-max_pixels",
          String(DECODER_MAX_PIXELS),
          "-i",
          inputPath,
          "-t",
          "0",
          "-f",
          "null",
          "-",
        ],
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
        return await assemble(directory, request);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

export const mediaProcessor: MediaProcessor = createFfmpegProcessor();
