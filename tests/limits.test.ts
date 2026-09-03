import { describe, expect, it } from "vitest";
import {
  MAX_CONTEXT,
  MAX_FOLDER_SOURCES,
  MAX_FOLDER_TITLE,
  MAX_FOLDERS,
  MAX_MARK_READ_SOURCES,
  MAX_SOURCES_PER_CALL,
  MEDIA_TYPES,
} from "@/limits";

describe("shared MCP/worker limits", () => {
  it("exports the numbers and media-type tuple locked into tools/list", () => {
    expect(MAX_SOURCES_PER_CALL).toBe(25);
    expect(MAX_CONTEXT).toBe(20);
    expect(MAX_MARK_READ_SOURCES).toBe(25);
    expect(MEDIA_TYPES).toEqual([
      "photo",
      "video",
      "document",
      "audio",
      "voice",
      "url",
      "gif",
    ]);
    expect(MAX_FOLDERS).toBe(10);
    expect(MAX_FOLDER_SOURCES).toBe(100);
    expect(MAX_FOLDER_TITLE).toBe(12);
  });
});
