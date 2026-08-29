import { describe, expect, it } from "vitest";
import {
  assertNoteInputBounded,
  MAX_ABOUT_CHARS,
  MAX_TOPICS,
  sourceNoteSchema,
  type SourceNoteInput,
} from "@/schemas/source-note";
import { GramScopeError } from "@/errors/taxonomy";

const valid: SourceNoteInput = {
  about: "Daily launch coverage with original photography.",
  topics: ["space", "launches"],
  kind: "reporting",
};

describe("assertNoteInputBounded", () => {
  it("accepts a note within every cap", () => {
    expect(() => assertNoteInputBounded(valid)).not.toThrow();
  });

  it("rejects an over-long about and names the limit", () => {
    const input = { ...valid, about: "x".repeat(MAX_ABOUT_CHARS + 1) };
    try {
      assertNoteInputBounded(input);
      throw new Error("expected a rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(GramScopeError);
      expect((err as GramScopeError).code).toBe("INVALID_INPUT");
      expect((err as GramScopeError).message).toContain(
        String(MAX_ABOUT_CHARS),
      );
    }
  });

  it("rejects an empty topics list", () => {
    expect(() => assertNoteInputBounded({ ...valid, topics: [] })).toThrow(
      GramScopeError,
    );
  });

  it("rejects too many topics and names the limit", () => {
    const topics = Array.from({ length: MAX_TOPICS + 1 }, (_, i) => `t${i}`);
    try {
      assertNoteInputBounded({ ...valid, topics });
      throw new Error("expected a rejection");
    } catch (err) {
      expect((err as GramScopeError).message).toContain(String(MAX_TOPICS));
    }
  });

  it("rejects an over-long single topic", () => {
    expect(() =>
      assertNoteInputBounded({ ...valid, topics: ["x".repeat(33)] }),
    ).toThrow(GramScopeError);
  });

  it("rejects a blank topic", () => {
    expect(() => assertNoteInputBounded({ ...valid, topics: ["  "] })).toThrow(
      GramScopeError,
    );
  });
});

describe("sourceNoteSchema", () => {
  it("parses a stored note", () => {
    const parsed = sourceNoteSchema.parse({
      id: "-1002222222222",
      handle: "@examplechannel",
      title: "Example Channel",
      about: "Launch coverage.",
      topics: ["space"],
      kind: "reporting",
      updated: "2026-08-29",
    });
    expect(parsed.id).toBe("-1002222222222");
  });

  it("stays permissive about a stored note that exceeds a current cap", () => {
    const parsed = sourceNoteSchema.parse({
      id: "-100111",
      title: "Old",
      about: "y".repeat(MAX_ABOUT_CHARS + 50),
      topics: ["a"],
      kind: "mixed",
      updated: "2026-01-01",
    });
    expect(parsed.about.length).toBeGreaterThan(MAX_ABOUT_CHARS);
  });

  it("rejects an unknown kind", () => {
    expect(() =>
      sourceNoteSchema.parse({
        id: "-100111",
        title: "Old",
        about: "a",
        topics: ["a"],
        kind: "newsletter",
        updated: "2026-01-01",
      }),
    ).toThrow();
  });
});
