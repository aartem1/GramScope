import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { loadConfig } from "@/config";
import { getMedia } from "@/media/service";
import { handleOriginalRequest } from "@/media/original-route";
import { issueMediaToken, verifyMediaToken } from "@/media/token";
import {
  INLINE_MEDIA_MAX_BYTES,
  type GetMediaInput,
} from "@/schemas/media";
import { withTelegram } from "@/telegram/client";
import {
  iterAssetBytes,
  resolveMediaAsset,
} from "@/telegram/media";
import {
  loadMediaLiveSelection,
  type MediaLiveSelection,
  type MediaMessageKind,
} from "./media-selectors";

const enabled = process.env.GRAMSCOPE_LIVE === "1";
const configurationSuite = enabled ? describe : describe.skip;
const suite = enabled ? describe : describe.skip;
let selection: MediaLiveSelection = {
  enabled: false,
  strict: false,
  selectors: {},
};
let selectorConfigurationError: unknown;

if (enabled) {
  try {
    selection = loadMediaLiveSelection(process.env);
  } catch (error) {
    selectorConfigurationError = error;
  }
}

function selectorFor(kind: MediaMessageKind) {
  return selection.selectors[kind];
}

function hasSelector(kind: MediaMessageKind): boolean {
  return selectorFor(kind) !== undefined;
}

function liveInput(
  kind: MediaMessageKind,
  overrides: Partial<GetMediaInput> = {},
): GetMediaInput {
  const selector = selectorFor(kind);
  if (!selector) throw new Error(`No live selector configured for ${kind}`);
  return {
    source_id: selector.sourceId,
    message_id: selector.messageId,
    mode: "auto",
    max_frames: 8,
    ...overrides,
  };
}

function liveRouteDependencies(now = new Date()) {
  const config = loadConfig();
  return {
    verifyToken: (token: string) =>
      verifyMediaToken(token, now, config.mediaTokenSecret),
    withClient: withTelegram,
    resolveAsset: resolveMediaAsset,
    iterBytes: iterAssetBytes,
    ownerId: config.ownerUserId,
  };
}

async function issuedToken(kind: MediaMessageKind, now = new Date()) {
  const selector = selectorFor(kind);
  if (!selector) throw new Error(`No live selector configured for ${kind}`);
  const config = loadConfig();
  return issueMediaToken({
    v: 1,
    purpose: "telegram-original",
    sourceId: selector.sourceId,
    messageId: selector.messageId,
    ownerId: config.ownerUserId,
  }, now, config.mediaTokenSecret);
}

configurationSuite("Telegram media live selector contract", () => {
  it("validates provided pairs and enables at least one selector", () => {
    if (selectorConfigurationError) throw selectorConfigurationError;
    expect(Object.keys(selection.selectors).length).toBeGreaterThan(0);
  });
});

suite("Telegram media against explicit real-account selectors", () => {
  it.runIf(hasSelector("PHOTO"))(
    "returns one bounded photo artifact without a follow-up",
    async () => {
      const outcome = await getMedia(liveInput("PHOTO"));
      expect(outcome.result.status).toBe("ready");
      expect(outcome.result.media?.type).toBe("photo");
      expect(outcome.artifact?.type).toBe("image");
      expect(outcome.artifact!.data.length).toBeLessThanOrEqual(
        INLINE_MEDIA_MAX_BYTES,
      );
    },
  );

  it.runIf(hasSelector("IMAGE_DOCUMENT"))(
    "returns a bounded image-document artifact",
    async () => {
      const outcome = await getMedia(liveInput("IMAGE_DOCUMENT"));
      expect(outcome.result.status).toBe("ready");
      expect(outcome.result.media?.type).toBe("document");
      expect(outcome.artifact?.type).toBe("image");
      expect(outcome.artifact!.data.length).toBeLessThanOrEqual(
        INLINE_MEDIA_MAX_BYTES,
      );
    },
  );

  for (const kind of ["VIDEO", "VIDEO_NOTE", "GIF"] as const) {
    it.runIf(hasSelector(kind))(
      `builds one labelled sheet for ${kind} within the automatic deadline`,
      async () => {
        const started = Date.now();
        const outcome = await getMedia(liveInput(kind));
        expect(outcome.result.status).toBe("ready");
        expect(outcome.artifact?.type).toBe("image");
        expect(outcome.result.representation?.frame_count).toBe(8);
        expect(outcome.artifact!.data.length).toBeLessThanOrEqual(
          INLINE_MEDIA_MAX_BYTES,
        );
        expect(Date.now() - started).toBeLessThan(25_000);
      },
    );
  }

  it.runIf(hasSelector("OVERSIZED_VIDEO"))(
    "degrades an oversized video before frame decoding",
    async () => {
      const outcome = await getMedia(liveInput("OVERSIZED_VIDEO"));
      expect(outcome.result.status).toBe("fallback");
      expect(outcome.result.code).toBe("INLINE_LIMIT_EXCEEDED");
      expect(outcome.link).toBeDefined();
    },
  );

  it.runIf(hasSelector("VOICE"))(
    "preserves bounded voice bytes and source metadata",
    async () => {
      const outcome = await getMedia(liveInput("VOICE"));
      expect(outcome.result.status).toBe("ready");
      expect(outcome.result.media?.type).toBe("voice");
      expect(outcome.artifact?.type).toBe("audio");
      expect(outcome.result.representation?.file_name)
        .toMatch(/^(voice-\d+\.[A-Za-z0-9]+|[^/]+\.[A-Za-z0-9]+)$/);
      expect(outcome.result.representation?.mime_type).toBeTruthy();

      const issued = await issuedToken("VOICE");
      const response = await handleOriginalRequest(
        new Request("https://gramscope.invalid/api/media/redacted"),
        issued.token,
        liveRouteDependencies(),
      );
      expect(response.status).toBe(200);
      const originalHash = createHash("sha256")
        .update(Buffer.from(await response.arrayBuffer()))
        .digest("hex");
      const artifactHash = createHash("sha256")
        .update(outcome.artifact!.data)
        .digest("hex");
      expect(artifactHash).toBe(originalHash);
    },
  );

  it.runIf(hasSelector("LARGE_VOICE"))(
    "returns a link instead of collecting an oversized voice note",
    async () => {
      const outcome = await getMedia(liveInput("LARGE_VOICE"));
      expect(outcome.result.status).toBe("fallback");
      expect(outcome.result.media?.type).toBe("voice");
      expect(outcome.artifact).toBeUndefined();
      expect(outcome.link).toBeDefined();
    },
  );

  it.runIf(hasSelector("AUDIO"))(
    "returns bounded source bytes for music audio",
    async () => {
      const outcome = await getMedia(liveInput("AUDIO"));
      expect(outcome.result.status).toBe("ready");
      expect(outcome.result.media?.type).toBe("audio");
      expect(outcome.artifact?.type).toBe("audio");
      expect(outcome.artifact!.data.length).toBeLessThanOrEqual(
        INLINE_MEDIA_MAX_BYTES,
      );
    },
  );

  it.runIf(hasSelector("DOCUMENT"))(
    "returns a generic document thumbnail when available and an original link",
    async () => {
      const outcome = await getMedia(liveInput("DOCUMENT"));
      expect(outcome.result.media?.type).toBe("document");
      expect(outcome.link).toBeDefined();
      if (outcome.result.media?.has_thumbnail) {
        expect(outcome.artifact?.type).toBe("image");
      }
    },
  );

  it.runIf(hasSelector("STICKER"))(
    "returns a bounded sticker preview or its original link",
    async () => {
      const outcome = await getMedia(liveInput("STICKER"));
      expect(
        outcome.artifact !== undefined || outcome.link !== undefined,
      ).toBe(true);
      expect(outcome.result.media?.type).toBe("sticker");
      if (outcome.artifact) {
        expect(outcome.artifact.data.length).toBeLessThanOrEqual(
          INLINE_MEDIA_MAX_BYTES,
        );
      }
    },
  );

  it.runIf(hasSelector("VIDEO"))(
    "builds one chronological sheet for exact timestamps",
    async () => {
      const outcome = await getMedia(liveInput("VIDEO", {
        timestamps_seconds: [8, 1, 5],
      }));
      expect(outcome.result.status).toBe("ready");
      expect(outcome.artifact?.type).toBe("image");
      expect(outcome.result.representation?.frame_count).toBe(3);
      expect(outcome.result.representation?.timestamps_seconds).toEqual([
        1,
        5,
        8,
      ]);
    },
  );

  it.runIf(hasSelector("PHOTO"))(
    "streams one full original through the authenticated handler",
    async () => {
      const issued = await issuedToken("PHOTO");
      const response = await handleOriginalRequest(
        new Request("https://gramscope.invalid/api/media/redacted"),
        issued.token,
        liveRouteDependencies(),
      );
      expect(response.status).toBe(200);
      const expected = Number(response.headers.get("content-length"));
      expect(expected).toBeGreaterThan(0);
      expect((await response.arrayBuffer()).byteLength).toBe(expected);
    },
  );

  it.runIf(hasSelector("OVERSIZED_VIDEO"))(
    "streams exactly the first one MiB of a large original",
    async () => {
      const issued = await issuedToken("OVERSIZED_VIDEO");
      const response = await handleOriginalRequest(
        new Request("https://gramscope.invalid/api/media/redacted", {
          headers: { range: "bytes=0-1048575" },
        }),
        issued.token,
        liveRouteDependencies(),
      );
      expect(response.status).toBe(206);
      expect(response.headers.get("content-length")).toBe("1048576");
      expect((await response.arrayBuffer()).byteLength).toBe(1_048_576);
    },
  );

  it.runIf(hasSelector("PHOTO"))(
    "rejects a tampered capability before Telegram access",
    async () => {
      const issued = await issuedToken("PHOTO");
      const response = await handleOriginalRequest(
        new Request("https://gramscope.invalid/api/media/redacted"),
        `${issued.token}x`,
        liveRouteDependencies(),
      );
      expect(response.status).toBe(401);
    },
  );

  it.runIf(hasSelector("PHOTO"))(
    "rejects an expired capability through an injected clock",
    async () => {
      const issuedAt = new Date("2026-08-30T12:00:00.000Z");
      const issued = await issuedToken("PHOTO", issuedAt);
      const response = await handleOriginalRequest(
        new Request("https://gramscope.invalid/api/media/redacted"),
        issued.token,
        liveRouteDependencies(new Date("2026-08-30T12:10:01.000Z")),
      );
      expect(response.status).toBe(401);
    },
  );

  it.runIf(hasSelector("OVERSIZED_VIDEO"))(
    "closes Telegram iteration when the client aborts",
    async () => {
      const issued = await issuedToken("OVERSIZED_VIDEO");
      let stopped = false;
      const dependencies = liveRouteDependencies();
      const response = await handleOriginalRequest(
        new Request("https://gramscope.invalid/api/media/redacted"),
        issued.token,
        {
          ...dependencies,
          iterBytes: async function* (client, asset, options) {
            try {
              yield* iterAssetBytes(client, asset, options);
            } finally {
              stopped = true;
            }
          },
        },
      );
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      await reader.cancel();
      expect(stopped).toBe(true);
    },
  );
});
