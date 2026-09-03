import { describe, expect, it } from "vitest";
import { loadConfig } from "@/config";
import { getMedia, type MediaDependencies } from "@/media/service";
import { handleOriginalRequest } from "@/media/original-route";
import { handleViewRequest } from "@/media/view-route";
import {
  issueMediaCapability,
  verifyMediaCapability,
} from "@/media/token";
import type { GetMediaInput } from "@/schemas/media";
import { withTelegram } from "@/telegram/client";
import { iterAssetBytes, resolveMediaAsset } from "@/telegram/media";
import { materializeMediaView } from "@/media/materializer";
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

function livePlanner() {
  const config = loadConfig();
  let resolveCalls = 0;
  const dependencies: MediaDependencies = {
    withClient: withTelegram,
    resolveAsset: async (client, input) => {
      resolveCalls += 1;
      return resolveMediaAsset(client, input);
    },
    issueCapability: (claims) =>
      issueMediaCapability(claims, new Date(), config.mediaTokenSecret),
    mediaOrigin: new URL(config.mcpResourceUrl).origin,
    ownerId: config.ownerUserId,
  };
  return { dependencies, resolveCalls: () => resolveCalls };
}

async function planned(kind: MediaMessageKind, overrides: Partial<GetMediaInput> = {}) {
  const planner = livePlanner();
  const outcome = await getMedia(liveInput(kind, overrides), planner.dependencies);
  // Planning is intentionally only the one Telegram message refetch. Opening
  // the capability performs the materialization or streaming work separately.
  expect(planner.resolveCalls()).toBe(1);
  expect(outcome.link).toBeDefined();
  return outcome;
}

function capabilityToken(uri: string): string {
  const token = new URL(uri).pathname.split("/").at(-1);
  if (!token) throw new Error("Media link has no capability token");
  return token;
}

function liveOriginalDependencies(now = new Date()) {
  const config = loadConfig();
  return {
    verifyToken: (token: string) =>
      verifyMediaCapability(token, now, config.mediaTokenSecret),
    withClient: withTelegram,
    resolveAsset: resolveMediaAsset,
    iterBytes: iterAssetBytes,
    ownerId: config.ownerUserId,
  };
}

function liveViewDependencies(now = new Date()) {
  const config = loadConfig();
  return {
    verifyToken: (token: string) =>
      verifyMediaCapability(token, now, config.mediaTokenSecret),
    withClient: withTelegram,
    resolveAsset: resolveMediaAsset,
    materialize: materializeMediaView,
    ownerId: config.ownerUserId,
  };
}

async function openPlanned(outcome: Awaited<ReturnType<typeof getMedia>>) {
  const link = outcome.link;
  if (!link?.uri) throw new Error("Expected a sealed media link");
  const token = capabilityToken(link.uri);
  const request = new Request(link.uri);
  return new URL(link.uri).pathname.startsWith("/api/media/view/")
    ? handleViewRequest(request, token, liveViewDependencies())
    : handleOriginalRequest(request, token, liveOriginalDependencies());
}

configurationSuite("Telegram media live selector contract", () => {
  it("validates provided pairs and enables at least one selector", () => {
    if (selectorConfigurationError) throw selectorConfigurationError;
    expect(Object.keys(selection.selectors).length).toBeGreaterThan(0);
  });
});

suite("Telegram media against explicit real-account selectors", () => {
  it.runIf(hasSelector("PHOTO"))(
    "plans a photo link and materializes it only through the view handler",
    async () => {
      const outcome = await planned("PHOTO");
      expect(outcome.link!.uri).toContain("/api/media/view/");
      const response = await openPlanned(outcome);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/jpeg");
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
    },
  );

  it.runIf(hasSelector("IMAGE_DOCUMENT"))(
    "plans an image document link and materializes it through the view handler",
    async () => {
      const outcome = await planned("IMAGE_DOCUMENT");
      expect(outcome.link!.uri).toContain("/api/media/view/");
      const response = await openPlanned(outcome);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/jpeg");
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
    },
  );

  for (const kind of ["VIDEO", "VIDEO_NOTE", "GIF"] as const) {
    it.runIf(hasSelector(kind))(
      `plans a contact-sheet link for ${kind} and materializes it through the view handler`,
      async () => {
        const outcome = await planned(kind);
        expect(outcome.link!.uri).toContain("/api/media/view/");
        const response = await openPlanned(outcome);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("image/jpeg");
        expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
      },
    );
  }

  for (const kind of ["VOICE", "LARGE_VOICE", "AUDIO"] as const) {
    it.runIf(hasSelector(kind))(
      `plans ${kind} as an original stream without fetching audio bytes`,
      async () => {
        const outcome = await planned(kind);
        expect(outcome.link!.uri).toContain("/api/media/");
        expect(outcome.link!.uri).not.toContain("/api/media/view/");
        const response = await openPlanned(outcome);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe(outcome.result.media?.mime_type);
        expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
      },
    );
  }

  it.runIf(hasSelector("DOCUMENT"))(
    "opens a planned document link through its matching handler",
    async () => {
      const outcome = await planned("DOCUMENT");
      const response = await openPlanned(outcome);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBeTruthy();
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
    },
  );

  it.runIf(hasSelector("STICKER"))(
    "opens a planned sticker link through its matching handler",
    async () => {
      const outcome = await planned("STICKER");
      const response = await openPlanned(outcome);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBeTruthy();
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
    },
  );

  it.runIf(hasSelector("VIDEO"))(
    "keeps explicit video timestamps in a link-only contact-sheet request",
    async () => {
      const outcome = await planned("VIDEO", {
        timestamps_seconds: [8, 1, 5],
      });
      expect(outcome.link!.uri).toContain("/api/media/view/");
      const response = await openPlanned(outcome);
      expect(response.status).toBe(200);
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
    },
  );

  it.runIf(hasSelector("PHOTO"))(
    "rejects a tampered planned capability before Telegram access",
    async () => {
      const outcome = await planned("PHOTO");
      const link = outcome.link!;
      if (!link.uri) throw new Error("Expected a sealed media link");
      const response = await handleViewRequest(
        new Request(link.uri),
        `${capabilityToken(link.uri)}x`,
        liveViewDependencies(),
      );
      expect(response.status).toBe(401);
    },
  );
});
