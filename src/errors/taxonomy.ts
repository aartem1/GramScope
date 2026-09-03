export const ERROR_CODES = [
  "CHANNEL_NOT_FOUND",
  "PRIVATE_CHANNEL_NOT_ACCESSIBLE",
  "NOT_A_MEMBER",
  "RATE_LIMITED",
  "AUTH_REQUIRED",
  "OWNER_FORBIDDEN",
  "INVALID_DATE_RANGE",
  "INVALID_CURSOR",
  "INVALID_INPUT",
  "MESSAGE_NOT_FOUND",
  "NO_DISCUSSION_THREAD",
  "INTERNAL_ERROR",
  "MEDIA_NOT_FOUND",
  "NO_MEDIA",
  "UNSUPPORTED_MEDIA",
  "INLINE_LIMIT_EXCEEDED",
  "PROCESSING_TIMEOUT",
  "TELEGRAM_DOWNLOAD_FAILED",
  "UPSTREAM_UNAVAILABLE",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type StructuredError = {
  code: ErrorCode;
  message: string;
  retry_after_seconds?: number;
  retryable?: boolean;
};

const RETRYABLE_BY_DEFAULT = new Set<ErrorCode>([
  "RATE_LIMITED",
  "PROCESSING_TIMEOUT",
  "TELEGRAM_DOWNLOAD_FAILED",
  "UPSTREAM_UNAVAILABLE",
]);

function defaultRetryable(code: ErrorCode): boolean {
  return RETRYABLE_BY_DEFAULT.has(code);
}

export class GramScopeError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly retryAfterSeconds?: number,
    public readonly retryable = defaultRetryable(code),
  ) {
    super(message);
    this.name = "GramScopeError";
  }

  toStructured(): StructuredError {
    return {
      code: this.code,
      message: this.message,
      ...(this.retryAfterSeconds !== undefined
        ? { retry_after_seconds: this.retryAfterSeconds }
        : {}),
      ...(this.retryable ? { retryable: true } : {}),
    };
  }
}

export function mediaError(
  code: ErrorCode,
  message: string,
  retryable?: boolean,
): GramScopeError {
  return new GramScopeError(code, message, undefined, retryable);
}
