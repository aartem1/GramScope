import { describe, expect, it } from "vitest";
import {
  assertNoteInputBounded,
  MAX_ABOUT_CHARS,
  MAX_CADENCE_CHARS,
  MAX_DERIVED_FROM_CHARS,
  MAX_LANG_CHARS,
  MAX_TOPIC_CHARS,
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

  it("accepts every input exactly at its cap", () => {
    const topics = Array.from({ length: MAX_TOPICS }, (_, index) =>
      String(index).padEnd(MAX_TOPIC_CHARS, "x"),
    );
    expect(() =>
      assertNoteInputBounded({
        about: "a".repeat(MAX_ABOUT_CHARS),
        topics,
        kind: "mixed",
        lang: "l".repeat(MAX_LANG_CHARS),
        cadence: "c".repeat(MAX_CADENCE_CHARS),
        derived_from: "d".repeat(MAX_DERIVED_FROM_CHARS),
      }),
    ).not.toThrow();
    expect(topics).toHaveLength(MAX_TOPICS);
    expect(topics.every((topic) => topic.length === MAX_TOPIC_CHARS)).toBe(
      true,
    );
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

  it("rejects an over-long topic by index and does not echo its text", () => {
    const prefix = "private-topic-";
    const topic = `${prefix}${"x".repeat(
      MAX_TOPIC_CHARS + 1 - prefix.length,
    )}`;
    try {
      assertNoteInputBounded({ ...valid, topics: [topic] });
      throw new Error("expected a rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(GramScopeError);
      expect((err as GramScopeError).code).toBe("INVALID_INPUT");
      expect((err as GramScopeError).message).toContain("topics[0]");
      expect((err as GramScopeError).message).toContain(
        String(MAX_TOPIC_CHARS + 1),
      );
      expect((err as GramScopeError).message).toContain(
        String(MAX_TOPIC_CHARS),
      );
      expect((err as GramScopeError).message).not.toContain(topic);
    }
  });

  it("rejects a blank topic", () => {
    expect(() => assertNoteInputBounded({ ...valid, topics: ["  "] })).toThrow(
      GramScopeError,
    );
  });

  it("rejects an over-long lang and names the limit", () => {
    const input = { ...valid, lang: "x".repeat(MAX_LANG_CHARS + 1) };
    try {
      assertNoteInputBounded(input);
      throw new Error("expected a rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(GramScopeError);
      expect((err as GramScopeError).code).toBe("INVALID_INPUT");
      expect((err as GramScopeError).message).toContain(
        String(MAX_LANG_CHARS),
      );
    }
  });

  it("rejects an over-long cadence and names the limit", () => {
    const input = { ...valid, cadence: "x".repeat(MAX_CADENCE_CHARS + 1) };
    try {
      assertNoteInputBounded(input);
      throw new Error("expected a rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(GramScopeError);
      expect((err as GramScopeError).code).toBe("INVALID_INPUT");
      expect((err as GramScopeError).message).toContain(
        String(MAX_CADENCE_CHARS),
      );
    }
  });

  it("rejects an over-long derived_from and names the limit", () => {
    const input = {
      ...valid,
      derived_from: "x".repeat(MAX_DERIVED_FROM_CHARS + 1),
    };
    try {
      assertNoteInputBounded(input);
      throw new Error("expected a rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(GramScopeError);
      expect((err as GramScopeError).code).toBe("INVALID_INPUT");
      expect((err as GramScopeError).message).toContain(
        String(MAX_DERIVED_FROM_CHARS),
      );
    }
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

  it("stays permissive about every stored field that exceeds a current cap", () => {
    const parsed = sourceNoteSchema.parse({
      id: "-100111",
      title: "Old",
      about: "y".repeat(MAX_ABOUT_CHARS + 50),
      topics: Array.from({ length: MAX_TOPICS + 1 }, (_, index) =>
        String(index).padEnd(MAX_TOPIC_CHARS + 1, "t"),
      ),
      kind: "mixed",
      lang: "l".repeat(MAX_LANG_CHARS + 1),
      cadence: "c".repeat(MAX_CADENCE_CHARS + 1),
      derived_from: "d".repeat(MAX_DERIVED_FROM_CHARS + 1),
      updated: "2026-01-01",
    });
    expect(parsed.about.length).toBeGreaterThan(MAX_ABOUT_CHARS);
    expect(parsed.topics).toHaveLength(MAX_TOPICS + 1);
  });

  it("rejects a stored note with no topics", () => {
    expect(() =>
      sourceNoteSchema.parse({
        id: "-100111",
        title: "Old",
        about: "a",
        topics: [],
        kind: "mixed",
        updated: "2026-01-01",
      }),
    ).toThrow();
  });

  it("rejects a stored note with a blank topic", () => {
    expect(() =>
      sourceNoteSchema.parse({
        id: "-100111",
        title: "Old",
        about: "a",
        topics: ["  "],
        kind: "mixed",
        updated: "2026-01-01",
      }),
    ).toThrow();
  });

  it.each([
    "2026-02-30",
    "2026-2-03",
    "2026-08-29T00:00:00.000Z",
    "not-a-date",
  ])("rejects invalid or non-ISO stored date %s", (updated) => {
    expect(() =>
      sourceNoteSchema.parse({
        id: "-100111",
        title: "Old",
        about: "a",
        topics: ["space"],
        kind: "mixed",
        updated,
      }),
    ).toThrow();
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
