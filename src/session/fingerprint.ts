import { createHash } from "node:crypto";

/**
 * Short non-secret id for comparing two session strings without printing them.
 * Equal fingerprints mean the same auth key is mounted in two places — the
 * condition that produces AUTH_KEY_DUPLICATED.
 */
export function sessionFingerprint(session: string): string {
  return createHash("sha256").update(session).digest("hex").slice(0, 16);
}
