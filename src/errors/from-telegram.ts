import { GramScopeError, type ErrorCode } from "./taxonomy";

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
    const mapped = EXACT[raw];
    if (mapped) return new GramScopeError(mapped, `Telegram error: ${raw}`);
    return new GramScopeError("INTERNAL_ERROR", `Telegram error: ${raw}`);
  }

  // Unknown failure: the original message may embed secrets, so it is dropped.
  return new GramScopeError("INTERNAL_ERROR", "Unexpected internal error");
}
