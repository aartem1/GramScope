import { describe, expect, it } from "vitest";
import {
  decodeCursor,
  decodeMessageCursor,
  encodeCursor,
  encodeMessageCursor,
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
    { sourceId: "-1001234567890", offsetId: 4242 },
    { sourceId: "-1009876543210", offsetId: 0 },
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
});
