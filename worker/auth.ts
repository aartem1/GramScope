import { timingSafeEqual } from "node:crypto";

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1];
}

/**
 * Compares the Authorization bearer token without throwing on unequal lengths.
 * Returns false for a missing or wrong token.
 */
export function verifyBearerToken(
  authorizationHeader: string | undefined,
  expectedToken: string,
): boolean {
  const provided = bearerToken(authorizationHeader);
  if (provided === undefined) return false;

  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expectedToken);
  if (providedBytes.length !== expectedBytes.length) return false;

  return timingSafeEqual(providedBytes, expectedBytes);
}
