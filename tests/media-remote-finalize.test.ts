import { describe, expect, it, vi } from "vitest";
import type { TelegramLike } from "@/telegram/client";
import type { MediaAsset } from "@/telegram/media";
import {
  finalizeMediaOutcome,
  planGetMedia,
  type MediaDependencies,
  type MediaOutcome,
} from "@/media/service";
import { mediaOutcomeSchema } from "@/ops/schemas";
import { sealMediaOutcomeForClient } from "@/ops/media-finalize";

function fakeAsset(): MediaAsset {
  return {
    sourceId: "@news",
    messageId: 7,
    descriptor: {
      media_id: "med_cTbYHpiy92mv4vHlI6lFWYUkxvIIbb9juDw3BNEPQK0",
      type: "photo",
      mime_type: "image/jpeg",
      size: 5,
      width: 100,
      height: 80,
    },
    rawMessage: {},
    rawMedia: {},
  } as MediaAsset;
}

function planDeps(asset = fakeAsset()): Pick<
  MediaDependencies,
  "withClient" | "resolveAsset"
> {
  const client = {} as TelegramLike;
  return {
    withClient: async <T>(run: (value: TelegramLike) => Promise<T>) => run(client),
    resolveAsset: vi.fn(async () => asset),
  };
}

describe("worker plan + Vercel finalize for get_media", () => {
  it("plans without issuing a capability or needing MEDIA_TOKEN_SECRET", async () => {
    const draft = await planGetMedia(
      { source_id: "@news", message_id: 7, mode: "auto", max_frames: 8 },
      planDeps(),
    );

    expect(draft.result.status).toBe("ready");
    expect(draft.result.download).toBeUndefined();
    expect(draft.link?.uri).toBeUndefined();
    expect(draft.unsignedClaims).toEqual({
      v: 2,
      purpose: "telegram-media",
      sourceId: "@news",
      messageId: 7,
      representation: { kind: "image", source: "auto" },
    });
    expect(mediaOutcomeSchema.parse(draft)).toEqual(draft);
  });

  it("finalizes a worker draft with Vercel-owned ownerId and secret", async () => {
    const draft = await planGetMedia(
      { source_id: "@news", message_id: 7, mode: "original", max_frames: 8 },
      planDeps(),
    );

    const issueCapability = vi.fn(async () => ({
      token: "issued-token",
      expiresAt: new Date("2026-09-03T12:10:00.000Z"),
    }));

    const outcome = await finalizeMediaOutcome(draft, {
      ownerId: "owner-1",
      mediaOrigin: "https://gramscope.test",
      issueCapability,
    });

    expect(issueCapability).toHaveBeenCalledWith({
      v: 2,
      purpose: "telegram-media",
      sourceId: "@news",
      messageId: 7,
      ownerId: "owner-1",
      representation: { kind: "original", byteSize: 5 },
    });
    expect(outcome.unsignedClaims).toBeUndefined();
    expect(outcome.result.download).toEqual({
      url: "https://gramscope.test/api/media/issued-token",
      expires_at: "2026-09-03T12:10:00.000Z",
    });
    expect(outcome.link?.uri).toBe(
      "https://gramscope.test/api/media/issued-token",
    );
  });

  it("sealMediaOutcomeForClient leaves finalized outcomes unchanged", async () => {
    const finalized: MediaOutcome = {
      result: {
        status: "ready",
        source_id: "@news",
        message_id: 7,
        download: {
          url: "https://gramscope.test/api/media/tok",
          expires_at: "2026-09-03T12:10:00.000Z",
        },
      },
      link: {
        uri: "https://gramscope.test/api/media/tok",
        name: "preview-7",
      },
    };

    await expect(
      sealMediaOutcomeForClient(finalized, {
        ownerId: "owner-1",
        mediaOrigin: "https://gramscope.test",
        issueCapability: vi.fn(),
      }),
    ).resolves.toEqual(finalized);
  });

  it("sealMediaOutcomeForClient issues tokens for unsigned worker drafts", async () => {
    const draft = await planGetMedia(
      { source_id: "@news", message_id: 7, mode: "auto", max_frames: 8 },
      planDeps(),
    );
    const issueCapability = vi.fn(async () => ({
      token: "view-token",
      expiresAt: new Date("2026-09-03T12:10:00.000Z"),
    }));

    const sealed = await sealMediaOutcomeForClient(draft, {
      ownerId: "owner-1",
      mediaOrigin: "https://gramscope.test",
      issueCapability,
    });

    expect(issueCapability).toHaveBeenCalledOnce();
    expect(sealed.unsignedClaims).toBeUndefined();
    expect(sealed.link?.uri).toContain("/api/media/view/view-token");
  });
});
