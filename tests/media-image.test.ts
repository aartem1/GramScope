import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { normalizeImage } from "@/media/image";
import { safeMediaFilename } from "@/media/names";
import { INLINE_MEDIA_MAX_BYTES } from "@/schemas/media";

describe("safeMediaFilename", () => {
  it("removes paths and control characters", () => {
    expect(safeMediaFilename({
      supplied: "../bad\u0000/name.ogg",
      kind: "voice",
      messageId: 42,
      mimeType: "audio/ogg",
    })).toBe("name.ogg");
    expect(safeMediaFilename({
      supplied: "..\\bad\\voice.ogg",
      kind: "voice",
      messageId: 42,
      mimeType: "audio/ogg",
    })).toBe("voice.ogg");
  });

  it("derives a stable extension when Telegram omitted the name", () => {
    expect(safeMediaFilename({ kind: "voice", messageId: 42, mimeType: "audio/ogg" }))
      .toBe("voice-42.ogg");
  });
});

describe("normalizeImage", () => {
  it("returns an already suitable source image unchanged", async () => {
    const source = await sharp({
      create: { width: 320, height: 180, channels: 3, background: "#cc3311" },
    }).jpeg().toBuffer();
    const image = await normalizeImage(source, { sourceMimeType: "image/jpeg" });
    expect(image.data).toBe(source);
    expect(image).toMatchObject({ mimeType: "image/jpeg", width: 320, height: 180 });
  });

  it("bounds dimensions and encoded bytes", async () => {
    const source = await sharp({
      create: { width: 4000, height: 3000, channels: 3, background: "#cc3311" },
    }).jpeg({ quality: 100 }).toBuffer();
    const image = await normalizeImage(source);
    expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(1600);
    expect(image.data.length).toBeLessThanOrEqual(INLINE_MEDIA_MAX_BYTES);
    expect(image.mimeType).toBe("image/jpeg");
  });

  it("keeps transparent sources in a transparency-preserving format", async () => {
    const source = await sharp({
      create: { width: 320, height: 180, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 0.5 } },
    }).png().toBuffer();
    const image = await normalizeImage(source, { preserveTransparency: true });
    expect(image.mimeType).toBe("image/webp");
  });
});
