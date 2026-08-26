import { z } from "zod";
import { GramScopeError } from "./errors/taxonomy";

export const CURSOR_VERSION = 1;

/**
 * Cursors from different tools share this envelope shape, so without a
 * discriminator a message or search cursor would decode cleanly here and
 * silently return the wrong page. Spec §6.3 forbids that; §7 requires a
 * foreign cursor to be rejected as INVALID_CURSOR.
 */
export const DIALOG_CURSOR_KIND = "dialogs";

/**
 * Telegram resumes getDialogs from offset_date + offset_id + offset_peer, but
 * offset_peer must be a real InputPeer TL object carrying an access hash, and
 * a stateless server has no entity cache to rebuild one from. We therefore
 * paginate on date + id only. The cost is that dialogs sharing an exact
 * last-message timestamp may tie at a page boundary; Task 11's live
 * disjoint-pages test is the guard on whether that ever bites in practice.
 */
export type DialogCursor = {
  offsetDate: number;
  offsetId: number;
};

const payloadSchema = z.object({
  v: z.literal(CURSOR_VERSION),
  k: z.literal(DIALOG_CURSOR_KIND),
  d: z.number().int(),
  i: z.number().int(),
});

export function encodeCursor(cursor: DialogCursor): string {
  const payload = {
    v: CURSOR_VERSION,
    k: DIALOG_CURSOR_KIND,
    d: cursor.offsetDate,
    i: cursor.offsetId,
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
      "Cursor is malformed, from another tool, or from an unsupported version",
    );
  }

  return {
    offsetDate: result.data.d,
    offsetId: result.data.i,
  };
}
