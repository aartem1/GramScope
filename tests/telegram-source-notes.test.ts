import { describe, expect, it } from "vitest";
import {
  noteMarker,
  parseNoteMessage,
  serializeNote,
} from "@/telegram/source-notes";
import type { SourceNote } from "@/schemas/source-note";

const note: SourceNote = {
  id: "-1002222222222",
  handle: "@examplechannel",
  title: "My **Cosmos**",
  about:
    'Covers `launches`, _orbital_ mechanics and **originals**; calls itself "the" source.',
  topics: ["space", "launches"],
  kind: "reporting",
  lang: "ru",
  cadence: "5-10/day",
  derived_from: "last 40 posts",
  updated: "2026-08-29",
};

describe("noteMarker", () => {
  it("drops the sign of a marked channel id", () => {
    expect(noteMarker("-1002222222222")).toBe("gs:src:1002222222222");
  });

  it("leaves a positive id alone", () => {
    expect(noteMarker("333")).toBe("gs:src:333");
  });
});

describe("serializeNote / parseNoteMessage", () => {
  it("round-trips a note whose text carries markdown and quotes", () => {
    const outcome = parseNoteMessage(serializeNote(note));
    expect(outcome.kind).toBe("note");
    if (outcome.kind !== "note") return;
    expect(outcome.note).toEqual(note);
  });

  it("puts the marker on its own first line", () => {
    const [first] = serializeNote(note).split("\n");
    expect(first).toBe("gs:src:1002222222222");
  });

  it("reports a message without the marker as not a note", () => {
    expect(parseNoteMessage("just some text").kind).toBe("other");
  });

  it("reports a marked message whose body is not JSON as malformed", () => {
    const outcome = parseNoteMessage("gs:src:100111\nnot json at all");
    expect(outcome.kind).toBe("malformed");
    if (outcome.kind !== "malformed") return;
    expect(outcome.reason).toContain("JSON");
  });

  it("reports a marked message whose JSON is not a note as malformed", () => {
    const outcome = parseNoteMessage('gs:src:100111\n{"id":"-100111"}');
    expect(outcome.kind).toBe("malformed");
  });

  it("reports a note whose marker disagrees with its id as malformed", () => {
    const wrong = serializeNote(note).replace(
      "gs:src:1002222222222",
      "gs:src:999",
    );
    const outcome = parseNoteMessage(wrong);
    expect(outcome.kind).toBe("malformed");
    if (outcome.kind !== "malformed") return;
    expect(outcome.reason).toContain("marker");
  });
});
