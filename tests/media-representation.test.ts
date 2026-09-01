import { describe, expect, it } from "vitest";
import { planMediaRepresentation } from "@/media/representation";
import type { MediaAsset } from "@/telegram/media";

const asset = (type: string, mimeType?: string, hasThumbnail = false): MediaAsset => ({
  sourceId: "-1001",
  messageId: 7,
  sourceHandle: "@news",
  descriptor: {
    media_id: `med_${type}`,
    type,
    ...(mimeType ? { mime_type: mimeType } : {}),
    ...(hasThumbnail ? { has_thumbnail: true } : {}),
  },
  rawMessage: { id: 7 },
  rawMedia: { className: "MessageMediaDocument" },
});

describe("media representation planning", () => {
  it.each([
    [asset("photo", "image/jpeg"), { kind: "image", source: "auto" }],
    [asset("video", "video/mp4"), { kind: "contact_sheet", maxFrames: 8 }],
    [asset("gif", "video/mp4"), { kind: "contact_sheet", maxFrames: 8 }],
    [asset("video_note", "video/mp4"), { kind: "contact_sheet", maxFrames: 8 }],
    [asset("voice", "audio/ogg"), { kind: "original" }],
    [asset("audio", "audio/mpeg"), { kind: "original" }],
    [asset("document", "application/pdf"), { kind: "original" }],
    [asset("document", "application/octet-stream", true), { kind: "image", source: "thumbnail" }],
    [asset("document", "application/octet-stream"), { kind: "original" }],
  ])("plans one automatic representation", (media, expected) => {
    expect(planMediaRepresentation(media, {
      source_id: "-1001",
      message_id: 7,
      mode: "auto",
      max_frames: 8,
    })).toMatchObject(expected);
  });

  it("keeps explicit frame timestamps in the capability plan", () => {
    expect(planMediaRepresentation(asset("video", "video/mp4"), {
      source_id: "-1001",
      message_id: 7,
      mode: "frames",
      max_frames: 4,
      timestamps_seconds: [8, 2],
    })).toEqual({
      kind: "contact_sheet",
      mode: "frames",
      maxFrames: 4,
      timestampsSeconds: [2, 8],
    });
  });
});
