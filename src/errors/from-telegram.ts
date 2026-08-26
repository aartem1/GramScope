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

  // Unknown failure: the original message may embed secrets, so it is dropped.
  return new GramScopeError("INTERNAL_ERROR", "Unexpected internal error");
}
