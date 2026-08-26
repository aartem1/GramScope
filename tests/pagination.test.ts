import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, type DialogCursor } from "@/pagination";
import { GramScopeError } from "@/errors/taxonomy";

const cursor: DialogCursor = {
  offsetDate: 1735689600,
  offsetId: 42,
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
      JSON.stringify({ v: 99, k: "dialogs", d: 1, i: 2 }),
    ).toString("base64url");
    expect(() => decodeCursor(forged)).toThrowError(/INVALID_CURSOR|version/i);
  });

  it("rejects a structurally wrong payload", () => {
    const forged = Buffer.from(
      JSON.stringify({ v: 1, k: "dialogs", d: "x" }),
    ).toString("base64url");
    expect(() => decodeCursor(forged)).toThrowError(GramScopeError);
  });

  it("carries a tool discriminator", () => {
    const decoded: unknown = JSON.parse(
      Buffer.from(encodeCursor(cursor), "base64url").toString("utf8"),
    );
    expect(decoded).toMatchObject({ k: "dialogs" });
  });

  it("rejects a foreign cursor of the same shape rather than returning a wrong page", () => {
    // Sub-projects 2 and 3 add message and search cursors with the same
    // {v,d,i} envelope. Without the discriminator one of those decodes here
    // and silently answers with the wrong page, which spec 6.3 forbids.
    const foreign = Buffer.from(
      JSON.stringify({ v: 1, k: "messages", d: 1, i: 2 }),
    ).toString("base64url");
    const error = (() => {
      try {
        decodeCursor(foreign);
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(GramScopeError);
    expect((error as GramScopeError).code).toBe("INVALID_CURSOR");
  });

  it("rejects a cursor with no discriminator at all", () => {
    const legacy = Buffer.from(JSON.stringify({ v: 1, d: 1, i: 2 })).toString(
      "base64url",
    );
    expect(() => decodeCursor(legacy)).toThrowError(GramScopeError);
  });
});
