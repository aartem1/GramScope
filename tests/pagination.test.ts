import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, type DialogCursor } from "@/pagination";
import { GramScopeError } from "@/errors/taxonomy";

const cursor: DialogCursor = {
  offsetDate: 1735689600,
  offsetId: 42,
  offsetPeerId: "-1001234567890",
};

describe("cursors", () => {
  it("round-trips", () => {
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("does not expose raw offsets in the encoded string", () => {
    expect(encodeCursor(cursor)).not.toContain("offsetDate");
  });

  it("rejects a tampered cursor", () => {
    expect(() => decodeCursor(encodeCursor(cursor) + "x")).toThrowError(
      GramScopeError,
    );
  });

  it("rejects a non-base64 cursor", () => {
    expect(() => decodeCursor("!!!not a cursor!!!")).toThrowError(
      GramScopeError,
    );
  });

  it("rejects a future cursor version", () => {
    const forged = Buffer.from(
      JSON.stringify({ v: 99, d: 1, i: 2, p: "3" }),
    ).toString("base64url");
    expect(() => decodeCursor(forged)).toThrowError(/INVALID_CURSOR|version/i);
  });

  it("rejects a structurally wrong payload", () => {
    const forged = Buffer.from(JSON.stringify({ v: 1, d: "x" })).toString(
      "base64url",
    );
    expect(() => decodeCursor(forged)).toThrowError(GramScopeError);
  });
});
