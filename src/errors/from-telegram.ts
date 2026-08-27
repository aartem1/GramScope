import { GramScopeError, type ErrorCode } from "./taxonomy";

// Real MTProto error codes are conventionally UPPER_SNAKE_CASE. Anything that
// does not match this shape is free text, which may embed a session string,
// and is never echoed back to the caller.
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

const EXACT: Record<string, ErrorCode> = {
  CHANNEL_INVALID: "CHANNEL_NOT_FOUND",
  CHANNEL_PRIVATE: "PRIVATE_CHANNEL_NOT_ACCESSIBLE",
  USERNAME_INVALID: "CHANNEL_NOT_FOUND",
  USERNAME_NOT_OCCUPIED: "CHANNEL_NOT_FOUND",
  PEER_ID_INVALID: "CHANNEL_NOT_FOUND",
  MSG_ID_INVALID: "MESSAGE_NOT_FOUND",
  AUTH_KEY_UNREGISTERED: "AUTH_REQUIRED",
  SESSION_REVOKED: "AUTH_REQUIRED",
  SESSION_EXPIRED: "AUTH_REQUIRED",
  USER_NOT_PARTICIPANT: "NOT_A_MEMBER",
};

function telegramMessage(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const candidate = (err as { errorMessage?: unknown }).errorMessage;
  return typeof candidate === "string" ? candidate : undefined;
}

/**
 * The head of the sentence teleproto throws when it gives up on a peer. The
 * tail embeds a JSON peer and a docs URL and is not matched.
 */
const UNRESOLVED_ENTITY = /^could not find the input entity for\b/i;

/**
 * teleproto resolves a bare marked channel id by calling
 * `channels.getChannels` with `accessHash: 0` (client/users.js, the
 * `PeerChannel` branch of `_getInputEntity`). On a cold instance — one that
 * holds no access hash for the channel, which is every instance for a channel
 * the account has not joined — that returns CHANNEL_INVALID. teleproto catches
 * that RPCError itself, logs it, and rethrows a plain `Error` carrying no
 * `errorMessage`, so the classification above never sees the code Telegram
 * actually sent and the failure lands on INTERNAL_ERROR.
 *
 * The rethrown object carries no code, no `cause` and no marker property: its
 * message is the only discriminator teleproto leaves. Matching it is therefore
 * the narrowest fix available, and it is deliberately narrow — a FLOOD_WAIT, an
 * auth failure or a socket error raised during the same resolution carries its
 * own shape and keeps its own classification. If teleproto rewords the
 * sentence, this predicate stops matching and such a failure falls back to
 * INTERNAL_ERROR, which is exactly today's behaviour, not a new wrong code;
 * `tests/errors.test.ts` pins the wording so a teleproto upgrade that changes
 * it fails the fast tier rather than silently regressing the error code.
 */
function isUnresolvedEntity(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // An RPCError is classified on its own terms above and never reaches here.
  if (telegramMessage(err) !== undefined) return false;
  return UNRESOLVED_ENTITY.test(err.message);
}

export function mapTelegramError(err: unknown): GramScopeError {
  if (err instanceof GramScopeError) return err;

  const raw = telegramMessage(err);
  if (raw) {
    const flood = /^FLOOD_WAIT_(\d+)$/.exec(raw);
    if (flood) {
      const seconds = Number(flood[1]);
      return new GramScopeError(
        "RATE_LIMITED",
        `Telegram rate limit; retry after ${seconds}s`,
        seconds,
      );
    }
    // Object.hasOwn, not `EXACT[raw]`: a bare index lookup resolves inherited
    // Object.prototype members, so errorMessage "constructor" would return a
    // function where an ErrorCode is declared.
    if (Object.hasOwn(EXACT, raw)) {
      return new GramScopeError(EXACT[raw]!, `Telegram error: ${raw}`);
    }
    if (SAFE_CODE.test(raw)) {
      return new GramScopeError("INTERNAL_ERROR", `Telegram error: ${raw}`);
    }
    return new GramScopeError("INTERNAL_ERROR", "Unexpected internal error");
  }

  if (isUnresolvedEntity(err)) {
    return new GramScopeError(
      "CHANNEL_NOT_FOUND",
      "Telegram could not resolve that peer. A channel the account has not joined must be addressed by @username or t.me link; a bare id resolves only while the peer is already known to this instance.",
    );
  }

  // Unknown failure: the original message may embed secrets, so it is dropped.
  return new GramScopeError("INTERNAL_ERROR", "Unexpected internal error");
}
