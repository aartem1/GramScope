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
export const MESSAGE_CURSOR_KIND = "messages";

const envelopeSchema = z.object({
  v: z.literal(CURSOR_VERSION),
  k: z.string(),
});

function encodePayload(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * Decodes one cursor kind. The envelope is checked before the body so a
 * foreign or outdated cursor is rejected on identity rather than on whichever
 * field happens to differ.
 */
function decodePayload<S extends z.ZodType>(
  raw: string,
  kind: string,
  schema: S,
): z.infer<S> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new GramScopeError(
      "INVALID_CURSOR",
      "Cursor is not decodable. next_cursor is an opaque token: pass it back exactly as it was returned, character for character. Do not shorten, re-type or reconstruct it.",
    );
  }

  const envelope = envelopeSchema.safeParse(parsed);
  if (!envelope.success || envelope.data.k !== kind) {
    throw new GramScopeError(
      "INVALID_CURSOR",
      "Cursor is from another tool or an unsupported version",
    );
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new GramScopeError("INVALID_CURSOR", "Cursor is malformed");
  }
  return result.data;
}

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
  /**
   * Ids already served whose dialog shares offsetDate. Telegram returns
   * dialogs with date <= offset_date INCLUSIVE, and offset_peer — the field
   * that would disambiguate the boundary — cannot be rebuilt by a stateless
   * server. Without this the boundary dialog is served twice.
   */
  boundaryIds: string[];
};

const dialogPayloadSchema = z.object({
  v: z.literal(CURSOR_VERSION),
  k: z.literal(DIALOG_CURSOR_KIND),
  d: z.number().int(),
  i: z.number().int(),
  b: z.array(z.string()).default([]),
});

export function encodeCursor(cursor: DialogCursor): string {
  return encodePayload({
    v: CURSOR_VERSION,
    k: DIALOG_CURSOR_KIND,
    d: cursor.offsetDate,
    i: cursor.offsetId,
    b: cursor.boundaryIds,
  });
}

export function decodeCursor(raw: string): DialogCursor {
  const payload = decodePayload(raw, DIALOG_CURSOR_KIND, dialogPayloadSchema);
  return {
    offsetDate: payload.d,
    offsetId: payload.i,
    boundaryIds: payload.b,
  };
}

/**
 * Message ids inside one peer are strictly monotonic, so an offset_id is an
 * exact resume point: there is no boundary tie to disambiguate and therefore
 * no boundaryIds equivalent here. `offsetId: 0` means "start from the newest".
 */
export type MessageCursor = {
  sources: Array<{ sourceId: string; offsetId: number }>;
};

const messagePayloadSchema = z.object({
  v: z.literal(CURSOR_VERSION),
  k: z.literal(MESSAGE_CURSOR_KIND),
  s: z.array(z.object({ i: z.string(), o: z.number().int() })),
});

export function encodeMessageCursor(cursor: MessageCursor): string {
  return encodePayload({
    v: CURSOR_VERSION,
    k: MESSAGE_CURSOR_KIND,
    s: cursor.sources.map((source) => ({
      i: source.sourceId,
      o: source.offsetId,
    })),
  });
}

export function decodeMessageCursor(raw: string): MessageCursor {
  const payload = decodePayload(raw, MESSAGE_CURSOR_KIND, messagePayloadSchema);
  return {
    sources: payload.s.map((source) => ({
      sourceId: source.i,
      offsetId: source.o,
    })),
  };
}
