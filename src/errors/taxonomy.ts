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
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type StructuredError = {
  code: ErrorCode;
  message: string;
  retry_after_seconds?: number;
};

export class GramScopeError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly retryAfterSeconds?: number,
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
    };
  }
}
