import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import sharp from "sharp";
import { GramScopeError, mediaError } from "../errors/taxonomy";
import { MAX_FRAMES } from "../schemas/media";
import { normalizeImage } from "./image";
import type {
  ContactSheetRequest,
  ContactSheetResult,
  MediaProcessor,
} from "./processor";

const MAX_DIAGNOSTIC_BYTES = 8 * 1024;

export type FrameRunner = (
  args: string[],
  outputDirectory: string,
  signal: AbortSignal,
) => Promise<void>;

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
    "-frames:v",
    "1",
    "-f",
    "image2",
    `${outputDirectory}/frame-${index}.png`,
  ]);
  return ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...inputs, ...outputs];
}

function processingTimeout(): GramScopeError {
  return mediaError("PROCESSING_TIMEOUT", "Video processing exceeded its deadline", true);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw processingTimeout();
}

async function runFfmpeg(args: string[], signal: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  if (!ffmpegPath) {
    throw mediaError("UNSUPPORTED_MEDIA", "Video processing is unavailable", false);
  }
  const binary = ffmpegPath;
  return new Promise<string>((resolve, reject) => {
    const child = spawn(binary, args, {
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
}

const defaultFrameRunner: FrameRunner = async (args, _outputDirectory, signal) => {
  await runFfmpeg(args, signal);
};

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
    const frame = await readFile(join(directory, `frame-${index}.png`));
    const cell = await sharp(frame, { failOn: "warning" })
      .rotate()
      .resize({ width: cellSize, height: cellSize, fit: "cover" })
      .jpeg({ quality: 90 })
      .toBuffer();
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
  const canvas = await sharp({
    create: { width, height, channels: 3, background: "black" },
  }).composite(overlays).png().toBuffer();
  throwIfAborted(request.deadline);
  const result = await normalizeImage(canvas, {
    maxBytes: request.maxBytes,
    maxLongEdge: request.maxLongEdge,
    sourceMimeType: "image/x-contact-sheet-source",
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

export function createFfmpegProcessor(options: { run?: FrameRunner } = {}): MediaProcessor {
  const run = options.run ?? defaultFrameRunner;
  return {
    async probeDuration(inputPath, deadline) {
      const stderr = await runFfmpeg(
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
        return await buildContactSheet(directory, request);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

export const mediaProcessor: MediaProcessor = createFfmpegProcessor();
