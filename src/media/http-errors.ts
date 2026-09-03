import { GramScopeError } from "../errors/taxonomy";

export function originalRouteErrorResponse(error: unknown): Response {
  if (error instanceof GramScopeError && error.code === "AUTH_REQUIRED") {
    return new Response("Unauthorized", { status: 401 });
  }
  if (
    error instanceof GramScopeError &&
    ["MEDIA_NOT_FOUND", "NO_MEDIA"].includes(error.code)
  ) {
    return new Response("Not Found", { status: 404 });
  }
  return new Response("Media download failed", { status: 502 });
}

export function viewRouteErrorResponse(error: unknown): Response {
  if (error instanceof GramScopeError) {
    if (error.code === "AUTH_REQUIRED" || error.code === "OWNER_FORBIDDEN") {
      return new Response("Unauthorized", { status: 401 });
    }
    if (["MEDIA_NOT_FOUND", "NO_MEDIA"].includes(error.code)) {
      return new Response("Not Found", { status: 404 });
    }
    if (["INLINE_LIMIT_EXCEEDED", "UNSUPPORTED_MEDIA"].includes(error.code)) {
      return new Response("Unprocessable Media", { status: 422 });
    }
    if (error.code === "PROCESSING_TIMEOUT") {
      return new Response("Media processing timed out", { status: 504 });
    }
  }
  return new Response("Media view failed", { status: 502 });
}

export function mediaDeliveryHttpStatus(error: unknown): {
  status: number;
  message: string;
  headers?: Record<string, string>;
} {
  if (error instanceof GramScopeError) {
    if (error.code === "AUTH_REQUIRED" || error.code === "OWNER_FORBIDDEN") {
      return { status: 401, message: "Unauthorized" };
    }
    if (["MEDIA_NOT_FOUND", "NO_MEDIA"].includes(error.code)) {
      return { status: 404, message: "Not Found" };
    }
    if (["INLINE_LIMIT_EXCEEDED", "UNSUPPORTED_MEDIA"].includes(error.code)) {
      return { status: 422, message: "Unprocessable Media" };
    }
    if (error.code === "PROCESSING_TIMEOUT") {
      return { status: 504, message: "Media processing timed out" };
    }
  }
  return { status: 502, message: "Media delivery failed" };
}
