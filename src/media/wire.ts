import { z } from "zod";

export const MEDIA_REQUEST_BODY_MAX_BYTES = 16_384;

const mediaRangeWireSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});

const mediaRepresentationWireSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("original") }).strict(),
  z.object({
    kind: z.literal("image"),
    source: z.enum(["auto", "thumbnail"]),
  }).strict(),
  z.object({
    kind: z.literal("contact_sheet"),
    mode: z.enum(["auto", "frames"]),
    maxFrames: z.number().int().min(1).max(10),
    timestampsSeconds: z.array(z.number().finite().nonnegative()).max(10).optional(),
  }).strict(),
]);

export const mediaRequestSchema = z.object({
  sourceId: z.string().min(1),
  messageId: z.number().int().positive(),
  representation: mediaRepresentationWireSchema,
  range: mediaRangeWireSchema.optional(),
});

export type MediaRequestBody = z.infer<typeof mediaRequestSchema>;
export type MediaRepresentationWire = MediaRequestBody["representation"];
export type MediaRangeWire = z.infer<typeof mediaRangeWireSchema>;
