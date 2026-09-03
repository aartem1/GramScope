import { createHash } from "node:crypto";
import { sessionFingerprint } from "../session/fingerprint";

/** Compare two secret values by fingerprint without exposing either. */
export function secretMatches(a: string, b: string): boolean {
  return sessionFingerprint(a) === sessionFingerprint(b);
}

/** Fingerprint any secret for display or comparison. */
export function fingerprintSecret(value: string): string {
  return sessionFingerprint(value);
}

/** Hash arbitrary bytes for certificate/key comparison. */
export function contentFingerprint(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/** Redact a value for logs — never print secrets. */
export function redactSecret(value: string | undefined): string {
  if (!value) return "(absent)";
  return `fp:${fingerprintSecret(value)}`;
}
