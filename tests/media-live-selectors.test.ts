import { describe, expect, it } from "vitest";
import { loadMediaLiveSelection } from "./live/media-selectors";

describe("media live selector contract", () => {
  it("exposes no runnable selectors without explicit live opt-in", () => {
    const selection = loadMediaLiveSelection({
      GRAMSCOPE_LIVE_MEDIA_SOURCE: "shared-source",
      GRAMSCOPE_LIVE_PHOTO_MESSAGE_ID: "101",
    });

    expect(selection.enabled).toBe(false);
    expect(selection.selectors).toEqual({});
  });

  it("runs only complete selectors in partial mode", () => {
    const selection = loadMediaLiveSelection({
      GRAMSCOPE_LIVE: "1",
      GRAMSCOPE_LIVE_MEDIA_SOURCE: "shared-source",
      GRAMSCOPE_LIVE_PHOTO_MESSAGE_ID: "101",
    });

    expect(selection.selectors.PHOTO).toEqual({
      sourceId: "shared-source",
      messageId: 101,
    });
    expect(selection.selectors.VIDEO).toBeUndefined();
  });

  it("uses a kind-specific source before the shared fallback", () => {
    const selection = loadMediaLiveSelection({
      GRAMSCOPE_LIVE: "1",
      GRAMSCOPE_LIVE_MEDIA_SOURCE: "shared-source",
      GRAMSCOPE_LIVE_PHOTO_SOURCE: "photo-source",
      GRAMSCOPE_LIVE_PHOTO_MESSAGE_ID: "101",
    });

    expect(selection.selectors.PHOTO).toEqual({
      sourceId: "photo-source",
      messageId: 101,
    });
  });

  it("names the first missing selector in strict mode", () => {
    expect(() => loadMediaLiveSelection({
      GRAMSCOPE_LIVE: "1",
      GRAMSCOPE_LIVE_STRICT: "1",
      GRAMSCOPE_LIVE_MEDIA_SOURCE: "shared-source",
      GRAMSCOPE_LIVE_PHOTO_MESSAGE_ID: "101",
    })).toThrow("GRAMSCOPE_LIVE_IMAGE_DOCUMENT_MESSAGE_ID");
  });

  it("keeps the shared source as the first strict requirement", () => {
    expect(() => loadMediaLiveSelection({
      GRAMSCOPE_LIVE: "1",
      GRAMSCOPE_LIVE_STRICT: "1",
      GRAMSCOPE_LIVE_PHOTO_MESSAGE_ID: "101",
    })).toThrow("GRAMSCOPE_LIVE_MEDIA_SOURCE is required");
  });

  it("rejects an invalid provided message id", () => {
    expect(() => loadMediaLiveSelection({
      GRAMSCOPE_LIVE: "1",
      GRAMSCOPE_LIVE_MEDIA_SOURCE: "shared-source",
      GRAMSCOPE_LIVE_PHOTO_MESSAGE_ID: "0",
    })).toThrow(
      "GRAMSCOPE_LIVE_PHOTO_MESSAGE_ID must be a positive safe integer",
    );
  });

  it("rejects a kind source without its message id", () => {
    expect(() => loadMediaLiveSelection({
      GRAMSCOPE_LIVE: "1",
      GRAMSCOPE_LIVE_PHOTO_SOURCE: "photo-source",
    })).toThrow("GRAMSCOPE_LIVE_PHOTO_MESSAGE_ID is required");
  });

  it("rejects a message id without a kind or shared source", () => {
    expect(() => loadMediaLiveSelection({
      GRAMSCOPE_LIVE: "1",
      GRAMSCOPE_LIVE_PHOTO_MESSAGE_ID: "101",
    })).toThrow("GRAMSCOPE_LIVE_PHOTO_SOURCE is required");
  });

  it("refuses a live run with zero complete media selectors", () => {
    expect(() => loadMediaLiveSelection({
      GRAMSCOPE_LIVE: "1",
      GRAMSCOPE_LIVE_MEDIA_SOURCE: "shared-source",
    })).toThrow("at least one complete media selector is required");
  });
});
