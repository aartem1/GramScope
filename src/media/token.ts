import { EncryptJWT, jwtDecrypt } from "jose";
import { z } from "zod";
import { loadConfig } from "../config";
import { GramScopeError } from "../errors/taxonomy";

const TTL_SECONDS = 10 * 60;

const mediaTokenClaimsSchema = z.object({
  v: z.literal(1),
  purpose: z.literal("telegram-original"),
  sourceId: z.string().min(1),
  messageId: z.number().int().positive(),
  ownerId: z.string().min(1),
});

export type MediaTokenClaims = z.infer<typeof mediaTokenClaimsSchema>;

export async function issueMediaToken(
  claims: MediaTokenClaims,
  now = new Date(),
  key = loadConfig().mediaTokenSecret,
): Promise<{ token: string; expiresAt: Date }> {
  const validated = mediaTokenClaimsSchema.parse(claims);
  const issuedAt = Math.floor(now.getTime() / 1000);
  const expiresAt = new Date((issuedAt + TTL_SECONDS) * 1000);
  const token = await new EncryptJWT({
    v: validated.v,
    purpose: validated.purpose,
    sourceId: validated.sourceId,
    messageId: validated.messageId,
    ownerId: validated.ownerId,
  })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM", typ: "JWT" })
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + TTL_SECONDS)
    .encrypt(key);
  return { token, expiresAt };
}

export async function verifyMediaToken(
  token: string,
  now = new Date(),
  key = loadConfig().mediaTokenSecret,
): Promise<MediaTokenClaims> {
  try {
    const { payload, protectedHeader } = await jwtDecrypt(token, key, {
      keyManagementAlgorithms: ["dir"],
      contentEncryptionAlgorithms: ["A256GCM"],
      currentDate: now,
    });
    if (protectedHeader.typ !== "JWT") throw new Error("invalid token type");
    return mediaTokenClaimsSchema.parse(payload);
  } catch {
    throw new GramScopeError(
      "AUTH_REQUIRED",
      "The media link is invalid or expired",
    );
  }
}
