import sharp from "sharp";
import { mediaError } from "../errors/taxonomy";
import { INLINE_MEDIA_MAX_BYTES } from "../schemas/media";

const QUALITIES = [82, 72, 62, 55] as const;
const EDGES = [1600, 1280, 1024, 768] as const;

export type ProcessedImage = {
  data: Buffer;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
};

export async function normalizeImage(
  source: Buffer,
  options: { preserveTransparency?: boolean; sourceMimeType?: string } = {},
): Promise<ProcessedImage> {
  const metadata = await sharp(source).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  const supportedSourceMime = ["image/jpeg", "image/png", "image/webp"].includes(
    options.sourceMimeType ?? "",
  );
  if (
    supportedSourceMime &&
    source.length <= INLINE_MEDIA_MAX_BYTES &&
    width > 0 &&
    height > 0 &&
    Math.max(width, height) <= EDGES[0]
  ) {
    return {
      data: source,
      mimeType: options.sourceMimeType as ProcessedImage["mimeType"],
      width,
      height,
    };
  }

  const transparent = options.preserveTransparency === true && metadata.hasAlpha === true;
  for (const edge of EDGES) {
    for (const quality of QUALITIES) {
      const pipeline = sharp(source, { failOn: "warning" })
        .rotate()
        .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true });
      const { data, info } = await (transparent
        ? pipeline.webp({ quality, alphaQuality: quality })
        : pipeline.jpeg({ quality, mozjpeg: true }))
        .toBuffer({ resolveWithObject: true });
      if (data.length <= INLINE_MEDIA_MAX_BYTES) {
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
