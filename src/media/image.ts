import sharp from "sharp";
import { mediaError } from "../errors/taxonomy";
import { INLINE_MEDIA_MAX_BYTES } from "../schemas/media";

const QUALITIES = [82, 72, 62, 55] as const;
const EDGES = [1600, 1280, 1024, 768] as const;
const SHARP_NATIVE_TIMEOUT_SECONDS = 5;

export type ProcessedImage = {
  data: Buffer;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
};

type SharpPipeline = ReturnType<typeof sharp>;

function processingTimeout(): ReturnType<typeof mediaError> {
  return mediaError("PROCESSING_TIMEOUT", "Media processing exceeded its deadline", true);
}

function isSharpTimeout(error: unknown): boolean {
  return error instanceof Error && /timeout/i.test(error.message);
}

export async function runSharpOperation<T>(
  pipeline: SharpPipeline,
  operation: (value: SharpPipeline) => Promise<T>,
  deadline?: AbortSignal,
): Promise<T> {
  if (!deadline) return operation(pipeline);
  if (deadline.aborted) {
    pipeline.destroy();
    throw processingTimeout();
  }

  // Sharp exposes a native libvips processing timeout, but no AbortSignal API.
  // The signal race returns promptly; destroy releases the JS stream, while
  // this timeout keeps any already-running native operation bounded.
  pipeline.timeout({ seconds: SHARP_NATIVE_TIMEOUT_SECONDS });
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, result?: T) => {
      if (settled) return;
      settled = true;
      deadline.removeEventListener("abort", abort);
      if (error !== undefined) {
        reject(deadline.aborted || isSharpTimeout(error) ? processingTimeout() : error);
      } else {
        resolve(result as T);
      }
    };
    const abort = () => {
      pipeline.destroy();
      finish(processingTimeout());
    };
    deadline.addEventListener("abort", abort, { once: true });
    if (deadline.aborted) abort();
    if (settled) return;
    try {
      operation(pipeline).then(
        (result) => finish(undefined, result),
        (error: unknown) => finish(error),
      );
    } catch (error) {
      finish(error);
    }
  });
}

export async function normalizeImage(
  source: Buffer,
  options: {
    preserveTransparency?: boolean;
    sourceMimeType?: string;
    maxBytes?: number;
    maxLongEdge?: number;
    deadline?: AbortSignal;
  } = {},
): Promise<ProcessedImage> {
  const maxBytes = options.maxBytes ?? INLINE_MEDIA_MAX_BYTES;
  const maxLongEdge = options.maxLongEdge ?? EDGES[0];
  const metadataPipeline = sharp(source);
  const metadata = await runSharpOperation(
    metadataPipeline,
    (pipeline) => pipeline.metadata(),
    options.deadline,
  );
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  const supportedSourceMime = ["image/jpeg", "image/png", "image/webp"].includes(
    options.sourceMimeType ?? "",
  );
  if (
    supportedSourceMime &&
    source.length <= maxBytes &&
    width > 0 &&
    height > 0 &&
    Math.max(width, height) <= maxLongEdge
  ) {
    return {
      data: source,
      mimeType: options.sourceMimeType as ProcessedImage["mimeType"],
      width,
      height,
    };
  }

  const transparent = options.preserveTransparency === true && metadata.hasAlpha === true;
  const edges = [maxLongEdge, ...EDGES.filter((edge) => edge < maxLongEdge)];
  for (const edge of edges) {
    for (const quality of QUALITIES) {
      const pipeline = sharp(source, { failOn: "warning" })
        .rotate()
        .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true });
      const output = transparent
        ? pipeline.webp({ quality, alphaQuality: quality })
        : pipeline.jpeg({ quality, mozjpeg: true });
      const { data, info } = await runSharpOperation(
        output,
        (value) => value.toBuffer({ resolveWithObject: true }),
        options.deadline,
      );
      if (data.length <= maxBytes) {
        return {
          data,
          mimeType: transparent ? "image/webp" : "image/jpeg",
          width: info.width,
          height: info.height,
        };
      }
    }
  }
  throw mediaError("INLINE_LIMIT_EXCEEDED", "Image cannot fit the inline media limit", false);
}
