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
}).strict();

const mediaTokenPayloadSchema = mediaTokenClaimsSchema.extend({
  iat: z.number().int(),
  exp: z.number().int(),
}).strict();

export type MediaTokenClaims = z.infer<typeof mediaTokenClaimsSchema>;

const representationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("original"),
    byteSize: z.number().int().positive().optional(),
  }).strict(),
  z.object({
    kind: z.literal("image"),
    source: z.enum(["auto", "thumbnail"]),
  }).strict(),
  z.object({
    kind: z.literal("contact_sheet"),
    mode: z.enum(["auto", "frames"]),
    maxFrames: z.number().int().min(1).max(10),
    timestampsSeconds: z.array(z.number().finite().nonnegative()).max(10).optional(),
  }).strict(),
]);

const mediaCapabilityClaimsSchema = z.object({
  v: z.literal(2),
  purpose: z.literal("telegram-media"),
  sourceId: z.string().min(1),
  messageId: z.number().int().positive(),
  ownerId: z.string().min(1),
  representation: representationSchema,
}).strict();

const mediaCapabilityPayloadSchema = mediaCapabilityClaimsSchema.extend({
  iat: z.number().int(),
  exp: z.number().int(),
}).strict();

export type MediaCapabilityClaims = z.infer<typeof mediaCapabilityClaimsSchema>;
export type VerifiedMediaCapability = MediaTokenClaims | MediaCapabilityClaims;

type MediaPayload = z.infer<typeof mediaTokenPayloadSchema>
  | z.infer<typeof mediaCapabilityPayloadSchema>;

function invalidMediaCapability(): GramScopeError {
  return new GramScopeError(
    "AUTH_REQUIRED",
    "The media link is invalid or expired",
  );
}

function claimsFromPayload(payload: MediaPayload): VerifiedMediaCapability {
  if (payload.v === 1) {
    return {
      v: payload.v,
      purpose: payload.purpose,
      sourceId: payload.sourceId,
      messageId: payload.messageId,
      ownerId: payload.ownerId,
    };
  }
  return {
    v: payload.v,
    purpose: payload.purpose,
    sourceId: payload.sourceId,
    messageId: payload.messageId,
    ownerId: payload.ownerId,
    representation: payload.representation,
  };
}

function parseMediaPayload(payload: unknown): MediaPayload {
  const version = typeof payload === "object" && payload !== null
    ? (payload as { v?: unknown }).v
    : undefined;
  const validated = version === 1
    ? mediaTokenPayloadSchema.parse(payload)
    : version === 2
      ? mediaCapabilityPayloadSchema.parse(payload)
      : undefined;
  if (!validated || validated.exp - validated.iat !== TTL_SECONDS) {
    throw invalidMediaCapability();
  }
  return validated;
}

async function decryptMediaPayload(
  token: string,
  now: Date,
  key: Uint8Array,
): Promise<MediaPayload> {
  const { payload, protectedHeader } = await jwtDecrypt(token, key, {
    keyManagementAlgorithms: ["dir"],
    contentEncryptionAlgorithms: ["A256GCM"],
    currentDate: now,
    requiredClaims: ["iat", "exp"],
  });
  if (protectedHeader.typ !== "JWT") throw invalidMediaCapability();
  return parseMediaPayload(payload);
}

async function issueValidatedMediaCapability(
  claims: MediaTokenClaims | MediaCapabilityClaims,
  now: Date,
  key: Uint8Array,
): Promise<{ token: string; expiresAt: Date }> {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const expiresAt = new Date((issuedAt + TTL_SECONDS) * 1000);
  const token = await new EncryptJWT(claims)
    .setProtectedHeader({ alg: "dir", enc: "A256GCM", typ: "JWT" })
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + TTL_SECONDS)
    .encrypt(key);
  return { token, expiresAt };
}

export async function issueMediaToken(
  claims: MediaTokenClaims,
  now = new Date(),
  key = loadConfig().mediaTokenSecret,
): Promise<{ token: string; expiresAt: Date }> {
  const validated = mediaTokenClaimsSchema.parse(claims);
  return issueValidatedMediaCapability(validated, now, key);
}

export async function issueMediaCapability(
  claims: MediaCapabilityClaims,
  now = new Date(),
  key = loadConfig().mediaTokenSecret,
): Promise<{ token: string; expiresAt: Date }> {
  const validated = mediaCapabilityClaimsSchema.parse(claims);
  return issueValidatedMediaCapability(validated, now, key);
}

export async function verifyMediaToken(
  token: string,
  now = new Date(),
  key = loadConfig().mediaTokenSecret,
): Promise<MediaTokenClaims> {
  try {
    const payload = await decryptMediaPayload(token, now, key);
    if (payload.v !== 1) throw invalidMediaCapability();
    return {
      v: payload.v,
      purpose: payload.purpose,
      sourceId: payload.sourceId,
      messageId: payload.messageId,
      ownerId: payload.ownerId,
    };
  } catch {
    throw invalidMediaCapability();
  }
}

export async function verifyMediaCapability(
  token: string,
  now = new Date(),
  key = loadConfig().mediaTokenSecret,
): Promise<VerifiedMediaCapability> {
  try {
    return claimsFromPayload(await decryptMediaPayload(token, now, key));
  } catch {
    throw invalidMediaCapability();
  }
}
