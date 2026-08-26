import { z } from "zod";
import { GramScopeError } from "./errors/taxonomy";

export const CURSOR_VERSION = 1;

export type DialogCursor = {
  offsetDate: number;
  offsetId: number;
  offsetPeerId: string;
};

const payloadSchema = z.object({
  v: z.literal(CURSOR_VERSION),
  d: z.number().int(),
  i: z.number().int(),
  p: z.string(),
});

export function encodeCursor(cursor: DialogCursor): string {
  const payload = {
    v: CURSOR_VERSION,
    d: cursor.offsetDate,
    i: cursor.offsetId,
    p: cursor.offsetPeerId,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor(raw: string): DialogCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new GramScopeError("INVALID_CURSOR", "Cursor is not decodable");
  }

  const result = payloadSchema.safeParse(parsed);
  if (!result.success) {
    throw new GramScopeError(
      "INVALID_CURSOR",
      "Cursor is malformed or from an unsupported version",
    );
  }

  return {
    offsetDate: result.data.d,
    offsetId: result.data.i,
    offsetPeerId: result.data.p,
  };
}
