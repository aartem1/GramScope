import { createHash } from "node:crypto";
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
  sources: Array<{
    /**
     * A HANDLE, not necessarily a marked id: a username when the source has
     * one. A bare marked id resolves only for peers the account holds, so a
     * channel reached by username must keep travelling by username across
     * cold instances. The wire key stays `i`, so older cursors still decode.
     */
    handle: string;
    offsetId: number;
  }>;
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
      i: source.handle,
      o: source.offsetId,
    })),
  });
}

export function decodeMessageCursor(raw: string): MessageCursor {
  const payload = decodePayload(raw, MESSAGE_CURSOR_KIND, messagePayloadSchema);
  return {
    sources: payload.s.map((source) => ({
      handle: source.i,
      offsetId: source.o,
    })),
  };
}

export const SEARCH_GLOBAL_CURSOR_KIND = "search_global";
export const SEARCH_SOURCES_CURSOR_KIND = "search_sources";
export const THREAD_CURSOR_KIND = "thread";
export const PINNED_CURSOR_KIND = "pinned";

/** Sorted keys and dropped undefined, so an absent filter and an omitted one
 * fingerprint alike and key order never matters. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, stable(entry)]),
    );
  }
  return value;
}

/**
 * Spec §8. A page-two cursor must not survive a changed query: without this the
 * second page silently answers a different question than the first.
 */
export function scopeFingerprint(parts: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(parts)))
    .digest("base64url")
    .slice(0, 16);
}

export function assertSameScope(found: string, expected: string): void {
  if (found === expected) return;
  throw new GramScopeError(
    "INVALID_CURSOR",
    "This cursor was issued for a different query, source selection or date range — the scope changed, so it no longer describes the same result set. Start a new search without a cursor.",
  );
}

export type SearchGlobalCursor = {
  /** The previous page's next_rate, Telegram's own resume key. */
  rate: number;
  /** Marked id of the last hit served; resolved to an InputPeer on resume. */
  peer: string;
  id: number;
  fingerprint: string;
};

const searchGlobalPayloadSchema = z.object({
  v: z.literal(CURSOR_VERSION),
  k: z.literal(SEARCH_GLOBAL_CURSOR_KIND),
  r: z.number().int(),
  p: z.string(),
  i: z.number().int(),
  f: z.string(),
});

export function encodeSearchGlobalCursor(cursor: SearchGlobalCursor): string {
  return encodePayload({
    v: CURSOR_VERSION,
    k: SEARCH_GLOBAL_CURSOR_KIND,
    r: cursor.rate,
    p: cursor.peer,
    i: cursor.id,
    f: cursor.fingerprint,
  });
}

export function decodeSearchGlobalCursor(raw: string): SearchGlobalCursor {
  const payload = decodePayload(
    raw,
    SEARCH_GLOBAL_CURSOR_KIND,
    searchGlobalPayloadSchema,
  );
  return {
    rate: payload.r,
    peer: payload.p,
    id: payload.i,
    fingerprint: payload.f,
  };
}

export type SearchSourcesCursor = {
  /** `handle`, not a marked id: see ResolvedSource.handle. */
  sources: Array<{ handle: string; offsetId: number }>;
  fingerprint: string;
};

const searchSourcesPayloadSchema = z.object({
  v: z.literal(CURSOR_VERSION),
  k: z.literal(SEARCH_SOURCES_CURSOR_KIND),
  s: z.array(z.object({ h: z.string(), o: z.number().int() })),
  f: z.string(),
});

export function encodeSearchSourcesCursor(cursor: SearchSourcesCursor): string {
  return encodePayload({
    v: CURSOR_VERSION,
    k: SEARCH_SOURCES_CURSOR_KIND,
    s: cursor.sources.map((source) => ({
      h: source.handle,
      o: source.offsetId,
    })),
    f: cursor.fingerprint,
  });
}

export function decodeSearchSourcesCursor(raw: string): SearchSourcesCursor {
  const payload = decodePayload(
    raw,
    SEARCH_SOURCES_CURSOR_KIND,
    searchSourcesPayloadSchema,
  );
  return {
    sources: payload.s.map((source) => ({
      handle: source.h,
      offsetId: source.o,
    })),
    fingerprint: payload.f,
  };
}

/** get_thread and get_pinned_messages page one stream by offset_id. Same
 * shape, separate kinds: a thread cursor must not decode as a pinned one. */
export type OffsetCursor = { offsetId: number; fingerprint: string };

function offsetPayloadSchema<K extends string>(kind: K) {
  return z.object({
    v: z.literal(CURSOR_VERSION),
    k: z.literal(kind),
    o: z.number().int(),
    f: z.string(),
  });
}

function encodeOffsetCursor(kind: string, cursor: OffsetCursor): string {
  return encodePayload({
    v: CURSOR_VERSION,
    k: kind,
    o: cursor.offsetId,
    f: cursor.fingerprint,
  });
}

function decodeOffsetCursor<K extends string>(
  raw: string,
  kind: K,
): OffsetCursor {
  const payload = decodePayload(raw, kind, offsetPayloadSchema(kind));
  return { offsetId: payload.o, fingerprint: payload.f };
}

export function encodeThreadCursor(cursor: OffsetCursor): string {
  return encodeOffsetCursor(THREAD_CURSOR_KIND, cursor);
}

export function decodeThreadCursor(raw: string): OffsetCursor {
  return decodeOffsetCursor(raw, THREAD_CURSOR_KIND);
}

export function encodePinnedCursor(cursor: OffsetCursor): string {
  return encodeOffsetCursor(PINNED_CURSOR_KIND, cursor);
}

export function decodePinnedCursor(raw: string): OffsetCursor {
  return decodeOffsetCursor(raw, PINNED_CURSOR_KIND);
}
