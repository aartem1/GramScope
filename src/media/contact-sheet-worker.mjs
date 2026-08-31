import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

const MAX_FRAMES = 10;
const QUALITIES = [82, 72, 62, 55];
const FALLBACK_EDGES = [1600, 1280, 1024, 768];

function fail(message) {
  throw new Error(message);
}

function timestampLabel(seconds, width) {
  const minutes = Math.floor(seconds / 60);
  const rest = (seconds % 60).toFixed(1).padStart(4, "0");
  return Buffer.from(
    `<svg width="${width}" height="28"><rect width="100%" height="28" fill="rgba(0,0,0,.65)"/><text x="8" y="20" fill="white" font-family="sans-serif" font-size="16">${minutes}:${rest}</text></svg>`,
  );
}

async function main() {
  const [, , directory, outputPath, rawRequest] = process.argv;
  if (!directory || !outputPath || !rawRequest) fail("Missing worker arguments");
  const request = JSON.parse(rawRequest);
  const timestamps = request.timestampsSeconds;
  if (!Array.isArray(timestamps) || timestamps.length < 1 || timestamps.length > MAX_FRAMES) {
    fail("Invalid frame count");
  }
  if (
    !Number.isInteger(request.maxBytes) || request.maxBytes < 1 ||
    !Number.isInteger(request.maxLongEdge) || request.maxLongEdge < 1 ||
    request.maxLongEdge > request.intermediateFrameMaxLongEdge ||
    !Number.isInteger(request.intermediateFrameMaxBytes) ||
    !Number.isInteger(request.intermediateFrameMaxLongEdge)
  ) {
    fail("Invalid worker limits");
  }

  const frameCount = timestamps.length;
  const columns = Math.ceil(Math.sqrt(frameCount));
  const rows = Math.ceil(frameCount / columns);
  const cellSize = Math.max(1, Math.floor(request.maxLongEdge / Math.max(columns, rows)));
  const width = columns * cellSize;
  const height = rows * cellSize;
  const overlays = [];
  const intermediateMaxPixels = request.intermediateFrameMaxLongEdge ** 2;

  for (let index = 0; index < frameCount; index += 1) {
    const framePath = join(directory, `frame-${index}.jpg`);
    const frameStats = await stat(framePath);
    if (frameStats.size > request.intermediateFrameMaxBytes) {
      fail("Decoded frame exceeds byte limit");
    }
    const metadata = await sharp(framePath, {
      failOn: "warning",
      limitInputPixels: intermediateMaxPixels,
    }).metadata();
    if (
      !metadata.width || !metadata.height ||
      Math.max(metadata.width, metadata.height) > request.intermediateFrameMaxLongEdge
    ) {
      fail("Decoded frame exceeds dimension limit");
    }
    const cell = await sharp(framePath, {
      failOn: "warning",
      limitInputPixels: intermediateMaxPixels,
    })
      .rotate()
      .resize({ width: cellSize, height: cellSize, fit: "cover" })
      .jpeg({ quality: 90 })
      .toBuffer();
    const left = (index % columns) * cellSize;
    const top = Math.floor(index / columns) * cellSize;
    overlays.push({ input: cell, left, top });
    overlays.push({
      input: timestampLabel(timestamps[index], cellSize),
      left,
      top: top + Math.max(0, cellSize - 28),
    });
  }

  const edges = [request.maxLongEdge, ...FALLBACK_EDGES.filter((edge) => edge < request.maxLongEdge)];
  for (const edge of edges) {
    for (const quality of QUALITIES) {
      const { data, info } = await sharp({
        create: { width, height, channels: 3, background: "black" },
      })
        .composite(overlays)
        .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      if (data.length <= request.maxBytes) {
        await writeFile(outputPath, data);
        process.stdout.write(JSON.stringify({ width: info.width, height: info.height }));
        return;
      }
    }
  }
  fail("Contact sheet exceeds byte limit");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Contact-sheet worker failed";
  process.stderr.write(message.slice(0, 8 * 1024));
  process.exitCode = 1;
});
