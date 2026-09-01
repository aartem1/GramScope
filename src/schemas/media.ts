import { createHash } from "node:crypto";
import { z } from "zod";

export const INLINE_MEDIA_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_FRAMES = 8;
export const MAX_FRAMES = 10;
export const MEDIA_MODES = ["auto", "preview", "frames", "original"] as const;
export const MEDIA_RESULT_CODES = [
  "MEDIA_NOT_FOUND",
  "NO_MEDIA",
  "UNSUPPORTED_MEDIA",
  "INLINE_LIMIT_EXCEEDED",
  "PROCESSING_TIMEOUT",
  "TELEGRAM_DOWNLOAD_FAILED",
] as const;

export function mediaId(
  sourceId: string,
  messageId: number,
  kind: string,
  rawId: string,
): string {
  const canonical = ["v1", sourceId, String(messageId), kind, rawId].join("\0");
  return `med_${createHash("sha256").update(canonical).digest("base64url")}`;
}

export const mediaDescriptorSchema = z.object({
  media_id: z.string().startsWith("med_"),
  type: z.string(),
  file_name: z.string().optional(),
  mime_type: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  duration_seconds: z.number().nonnegative().optional(),
  has_thumbnail: z.boolean().optional(),
});

export const getMediaInputSchema = z.object({
  source_id: z.string().min(1),
  message_id: z.number().int().positive(),
  mode: z.enum(MEDIA_MODES).default("auto"),
  timestamps_seconds: z.array(z.number().finite().nonnegative()).max(MAX_FRAMES).optional(),
  max_frames: z.number().int().min(1).max(MAX_FRAMES).default(DEFAULT_MAX_FRAMES),
}).superRefine((value, ctx) => {
  if (value.mode === "original" && value.timestamps_seconds?.length) {
    ctx.addIssue({
      code: "custom",
      path: ["timestamps_seconds"],
      message: "timestamps_seconds cannot be combined with mode=original",
    });
  }
});

export type GetMediaInput = z.infer<typeof getMediaInputSchema>;
export type MediaDescriptor = z.infer<typeof mediaDescriptorSchema>;
export type MediaResultCode = (typeof MEDIA_RESULT_CODES)[number];

export const mediaRepresentationSchema = z.object({
  kind: z.enum(["image", "audio", "document", "download", "metadata"]),
  delivery: z.literal("resource_link").optional(),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
  byte_size: z.number().int().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  frame_count: z.number().int().min(1).max(MAX_FRAMES).optional(),
  timestamps_seconds: z.array(z.number().nonnegative()).max(MAX_FRAMES).optional(),
});

export const getMediaResultSchema = z.object({
  status: z.enum(["ready", "fallback", "error"]),
  source_id: z.string(),
  message_id: z.number().int().positive(),
  media: mediaDescriptorSchema.optional(),
  representation: mediaRepresentationSchema.optional(),
  download: z.object({ url: z.url(), expires_at: z.iso.datetime() }).optional(),
  code: z.enum(MEDIA_RESULT_CODES).optional(),
  retryable: z.boolean().optional(),
  message: z.string().optional(),
});

export type GetMediaResult = z.infer<typeof getMediaResultSchema>;
