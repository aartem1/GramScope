import { mediaError } from "../errors/taxonomy";
import { DEFAULT_MAX_FRAMES, type GetMediaInput } from "../schemas/media";
import type { MediaAsset } from "../telegram/media";

export type MediaRepresentationPlan =
  | { kind: "original" }
  | { kind: "image"; source: "auto" | "thumbnail" }
  | {
      kind: "contact_sheet";
      mode: "auto" | "frames";
      maxFrames: number;
      timestampsSeconds?: number[];
    };

const ORIGINAL_DOCUMENT_MIMES = new Set([
  "application/pdf",
  "application/json",
  "text/csv",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

export function planMediaRepresentation(
  asset: MediaAsset,
  input: GetMediaInput,
): MediaRepresentationPlan {
  const mode = input.timestamps_seconds?.length ? "frames" : input.mode;
  if (mode === "original") return { kind: "original" };
  if (mode === "preview") {
    if (asset.descriptor.type === "photo" || asset.descriptor.mime_type?.startsWith("image/")) {
      return { kind: "image", source: "auto" };
    }
    if (asset.descriptor.has_thumbnail) return { kind: "image", source: "thumbnail" };
    throw mediaError("UNSUPPORTED_MEDIA", "No image preview is available", false);
  }
  if (mode === "frames") {
    if (!["video", "gif", "video_note"].includes(asset.descriptor.type)) {
      throw mediaError("UNSUPPORTED_MEDIA", "Frames require video media", false);
    }
    return {
      kind: "contact_sheet",
      mode: "frames",
      maxFrames: input.max_frames,
      ...(input.timestamps_seconds?.length
        ? { timestampsSeconds: [...input.timestamps_seconds].sort((a, b) => a - b) }
        : {}),
    };
  }
  switch (asset.descriptor.type) {
    case "photo":
      return { kind: "image", source: "auto" };
    case "video":
    case "gif":
    case "video_note":
      return { kind: "contact_sheet", mode: "auto", maxFrames: DEFAULT_MAX_FRAMES };
    case "voice":
    case "audio":
      return { kind: "original" };
    case "sticker":
      if (asset.descriptor.mime_type?.startsWith("image/")) {
        return { kind: "image", source: "auto" };
      }
      return asset.descriptor.has_thumbnail
        ? { kind: "image", source: "thumbnail" }
        : { kind: "original" };
    case "document": {
      const mime = asset.descriptor.mime_type ?? "";
      if (mime.startsWith("image/")) return { kind: "image", source: "auto" };
      if (mime.startsWith("text/") || ORIGINAL_DOCUMENT_MIMES.has(mime)) {
        return { kind: "original" };
      }
      return asset.descriptor.has_thumbnail
        ? { kind: "image", source: "thumbnail" }
        : { kind: "original" };
    }
    default:
      throw mediaError("UNSUPPORTED_MEDIA", "No downloadable media representation is available", false);
  }
}
