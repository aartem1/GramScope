import { describe, expect, it } from "vitest";
import {
  assertSameScope,
  decodeCursor,
  decodeMessageCursor,
  decodePinnedCursor,
  decodeSearchGlobalCursor,
  decodeSearchSourcesCursor,
  decodeSourceNotesCursor,
  decodeThreadCursor,
  encodeCursor,
  encodeMessageCursor,
  encodePinnedCursor,
  encodeSearchGlobalCursor,
  encodeSearchSourcesCursor,
  encodeThreadCursor,
  scopeFingerprint,
  type DialogCursor,
  type MessageCursor,
} from "@/pagination";
import { GramScopeError } from "@/errors/taxonomy";

const cursor: DialogCursor = {
  offsetDate: 1735689600,
  offsetId: 42,
  boundaryIds: ["-1001", "-1002"],
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

const messageCursor: MessageCursor = {
  sources: [
    { handle: "-1001234567890", offsetId: 4242 },
    { handle: "-1009876543210", offsetId: 0 },
  ],
};

describe("message cursors", () => {
  it("round-trips a per-source offset list", () => {
    expect(decodeMessageCursor(encodeMessageCursor(messageCursor))).toEqual(
      messageCursor,
    );
  });

  it("carries its own kind discriminator", () => {
    const decoded: unknown = JSON.parse(
      Buffer.from(encodeMessageCursor(messageCursor), "base64url").toString(
        "utf8",
      ),
    );
    expect(decoded).toMatchObject({ k: "messages" });
  });

  it("refuses a dialog cursor rather than returning a wrong page", () => {
    const error = (() => {
      try {
        decodeMessageCursor(encodeCursor(cursor));
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(GramScopeError);
    expect((error as GramScopeError).code).toBe("INVALID_CURSOR");
  });

  it("refuses a message cursor at the dialog decoder", () => {
    expect(() => decodeCursor(encodeMessageCursor(messageCursor))).toThrowError(
      GramScopeError,
    );
  });

  it("refuses a future version", () => {
    const forged = Buffer.from(
      JSON.stringify({ v: 99, k: "messages", s: [] }),
    ).toString("base64url");
    expect(() => decodeMessageCursor(forged)).toThrowError(GramScopeError);
  });

  it("refuses a structurally wrong payload", () => {
    const forged = Buffer.from(
      JSON.stringify({ v: 1, k: "messages", s: [{ i: 1, o: "x" }] }),
    ).toString("base64url");
    expect(() => decodeMessageCursor(forged)).toThrowError(GramScopeError);
  });

  it("decodes a hand-built payload on the `i` wire key, pinning the wire format", () => {
    // Every other test here round-trips through encodeMessageCursor, so all
    // of them would still pass if the payload key were renamed on both sides
    // at once. This literal is not produced by the encoder: it pins the key
    // a cursor already issued to a live connector actually uses.
    const literal = Buffer.from(
      JSON.stringify({
        v: 1,
        k: "messages",
        s: [{ i: "-1001234567890", o: 42 }],
      }),
    ).toString("base64url");
    expect(decodeMessageCursor(literal)).toEqual({
      sources: [{ handle: "-1001234567890", offsetId: 42 }],
    });
  });
});

// A connector hands the cursor to a language model, which passes it back as a
// plain string argument. Whitespace is the one mangling that is recoverable,
// and it costs nothing to absorb; anything else must still be rejected.
describe("cursor transport robustness", () => {
  it("decodes a cursor that came back with surrounding or internal whitespace", () => {
    const issued = encodeMessageCursor({
      sources: [
        { handle: "-1006666666666", offsetId: 9758 },
        { handle: "-1007777777777", offsetId: 2248 },
      ],
    });

    for (const mangled of [
      `  ${issued}  `,
      `\n${issued}\n`,
      `${issued.slice(0, 40)}\n${issued.slice(40)}`,
      `${issued.slice(0, 40)} ${issued.slice(40)}`,
    ]) {
      const decoded = decodeMessageCursor(mangled);
      expect(decoded.sources).toEqual([
        { handle: "-1006666666666", offsetId: 9758 },
        { handle: "-1007777777777", offsetId: 2248 },
      ]);
    }
  });

  it("still rejects a cursor whose characters were actually altered", () => {
    const issued = encodeMessageCursor({
      sources: [{ handle: "-1006666666666", offsetId: 9758 }],
    });
    // Drop a character, which is what a model retyping the token does.
    const truncated = issued.slice(0, issued.length - 6);
    let error: unknown;
    try {
      decodeMessageCursor(truncated);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GramScopeError);
    expect((error as GramScopeError).code).toBe("INVALID_CURSOR");
  });

  it("tells the caller the cursor is opaque and must be echoed verbatim", () => {
    let error: unknown;
    try {
      decodeMessageCursor("not-a-cursor!!!");
    } catch (caught) {
      error = caught;
    }
    expect((error as GramScopeError).message).toMatch(/exactly as/i);
  });
});

describe("scopeFingerprint", () => {
  it("ignores key order and absent filters", () => {
    expect(scopeFingerprint({ q: "x", from: undefined })).toBe(
      scopeFingerprint({ from: undefined, q: "x" }),
    );
    expect(scopeFingerprint({ q: "x" })).toBe(
      scopeFingerprint({ q: "x", to: undefined }),
    );
  });

  it("changes when any filter changes", () => {
    const base = scopeFingerprint({ q: "x", sources: ["-1001"] });
    expect(scopeFingerprint({ q: "y", sources: ["-1001"] })).not.toBe(base);
    expect(scopeFingerprint({ q: "x", sources: ["-1002"] })).not.toBe(base);
    expect(scopeFingerprint({ q: "x", sources: ["-1001"], to: "2026" })).not.toBe(
      base,
    );
  });
});

describe("the search cursors", () => {
  it("round-trips a global cursor", () => {
    const cursor = { rate: 42, peer: "-100111", id: 7, fingerprint: "abc" };
    expect(decodeSearchGlobalCursor(encodeSearchGlobalCursor(cursor))).toEqual(
      cursor,
    );
  });

  it("round-trips a per-source cursor", () => {
    const cursor = {
      sources: [
        { handle: "-100111", offsetId: 9 },
        { handle: "exampleuser", offsetId: 0 },
      ],
      fingerprint: "abc",
    };
    expect(decodeSearchSourcesCursor(encodeSearchSourcesCursor(cursor))).toEqual(
      cursor,
    );
  });

  it("round-trips thread and pinned cursors", () => {
    const cursor = { offsetId: 5, fingerprint: "abc" };
    expect(decodeThreadCursor(encodeThreadCursor(cursor))).toEqual(cursor);
    expect(decodePinnedCursor(encodePinnedCursor(cursor))).toEqual(cursor);
  });

  it("rejects a cursor from another tool", () => {
    const thread = encodeThreadCursor({ offsetId: 5, fingerprint: "abc" });
    expect(() => decodePinnedCursor(thread)).toThrow(GramScopeError);
    expect(() => decodeSearchGlobalCursor(thread)).toThrow(GramScopeError);
    expect(() => decodeSearchSourcesCursor(thread)).toThrow(GramScopeError);
  });

  it("refuses a pinned cursor where a source-notes cursor is expected", () => {
    const foreign = encodePinnedCursor({ offsetId: 5, fingerprint: "f" });
    expect(() => decodeSourceNotesCursor(foreign)).toThrow(/another tool/);
  });
});

describe("assertSameScope", () => {
  it("passes an unchanged scope and rejects a changed one", () => {
    expect(() => assertSameScope("abc", "abc")).not.toThrow();
    try {
      assertSameScope("abc", "def");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GramScopeError);
      expect((err as GramScopeError).code).toBe("INVALID_CURSOR");
      expect((err as GramScopeError).message).toMatch(/scope/i);
    }
  });
});
