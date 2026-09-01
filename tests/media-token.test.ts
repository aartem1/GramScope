import { describe, expect, it } from "vitest";
import { decodeProtectedHeader, EncryptJWT, jwtDecrypt } from "jose";
import {
  issueMediaCapability,
  issueMediaToken,
  verifyMediaCapability,
  verifyMediaToken,
  type MediaCapabilityClaims,
  type MediaTokenClaims,
} from "@/media/token";

const KEY = new Uint8Array(32).fill(7);

const claims: MediaTokenClaims = {
  v: 1,
  purpose: "telegram-original",
  sourceId: "-1001",
  messageId: 7,
  ownerId: "owner-1",
};

const v2Claims: MediaCapabilityClaims = {
  v: 2,
  purpose: "telegram-media",
  sourceId: "-1001",
  messageId: 7,
  ownerId: "owner-1",
  representation: {
    kind: "contact_sheet",
    mode: "auto",
    maxFrames: 8,
  },
};

describe("media capability tokens", () => {
  it("round-trips an encrypted ten-minute capability", async () => {
    const now = new Date("2026-08-30T12:00:00Z");
    const issued = await issueMediaToken(claims, now, KEY);

    expect(decodeProtectedHeader(issued.token)).toMatchObject({
      alg: "dir",
      enc: "A256GCM",
    });
    expect(issued.token).not.toContain("-1001");
    expect(issued.expiresAt.toISOString()).toBe("2026-08-30T12:10:00.000Z");
    const { payload } = await jwtDecrypt(issued.token, KEY, { currentDate: now });
    expect(Object.keys(payload).sort()).toEqual([
      "exp",
      "iat",
      "messageId",
      "ownerId",
      "purpose",
      "sourceId",
      "v",
    ]);
    await expect(
      verifyMediaToken(issued.token, new Date("2026-08-30T12:09:59Z"), KEY),
    ).resolves.toEqual(claims);
  });

  it("rejects tampering and expiry with the same safe error", async () => {
    const issued = await issueMediaToken(
      claims,
      new Date("2026-08-30T12:00:00Z"),
      KEY,
    );

    await expect(
      verifyMediaToken(`${issued.token}x`, new Date(), KEY),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    await expect(
      verifyMediaToken(issued.token, new Date("2026-08-30T12:10:01Z"), KEY),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("rejects a token with the wrong purpose or version", async () => {
    const now = new Date("2026-08-30T12:00:00Z");
    const encrypt = (overrides: Record<string, unknown>) => new EncryptJWT({
      ...claims,
      ...overrides,
    })
      .setProtectedHeader({ alg: "dir", enc: "A256GCM", typ: "JWT" })
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(Math.floor(now.getTime() / 1000) + 600)
      .encrypt(KEY);

    await expect(
      verifyMediaToken(await encrypt({ purpose: "other" }), now, KEY),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    await expect(
      verifyMediaToken(await encrypt({ v: 2 }), now, KEY),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it.each([
    ["missing exp", { ...claims, iat: 1_788_091_200 }],
    ["missing iat", { ...claims, exp: 1_788_091_800 }],
    ["an overlong lifetime", {
      ...claims,
      iat: 1_788_091_200,
      exp: 1_788_091_801,
    }],
    ["an extra payload claim", {
      ...claims,
      iat: 1_788_091_200,
      exp: 1_788_091_800,
      file_name: "must-not-pass.txt",
    }],
  ] as const)("rejects a crafted token with %s", async (_case, payload) => {
    const token = await new EncryptJWT(payload)
      .setProtectedHeader({ alg: "dir", enc: "A256GCM", typ: "JWT" })
      .encrypt(KEY);

    await expect(
      verifyMediaToken(token, new Date("2026-08-30T12:05:00Z"), KEY),
    ).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      message: "The media link is invalid or expired",
    });
  });

  it("round-trips one strict version-2 representation capability", async () => {
    const now = new Date("2026-09-01T12:00:00Z");
    const issued = await issueMediaCapability(v2Claims, now, KEY);
    const { payload } = await jwtDecrypt(issued.token, KEY, { currentDate: now });
    expect(Object.keys(payload).sort()).toEqual([
      "exp", "iat", "messageId", "ownerId", "purpose",
      "representation", "sourceId", "v",
    ]);
    await expect(verifyMediaCapability(issued.token, now, KEY)).resolves.toEqual(v2Claims);
  });

  const representations: MediaCapabilityClaims["representation"][] = [
    { kind: "original" },
    { kind: "image", source: "thumbnail" },
    { kind: "contact_sheet", mode: "frames", maxFrames: 4, timestampsSeconds: [2, 8] },
  ];

  it.each(representations)("round-trips a version-2 %s representation", async (representation) => {
    const issued = await issueMediaCapability({
      ...v2Claims,
      representation,
    }, new Date("2026-09-01T12:00:00Z"), KEY);

    await expect(verifyMediaCapability(
      issued.token,
      new Date("2026-09-01T12:00:00Z"),
      KEY,
    )).resolves.toMatchObject({ representation });
  });

  it("continues to verify an unexpired version-1 original capability", async () => {
    const now = new Date("2026-09-01T12:00:00Z");
    const issued = await issueMediaToken(claims, now, KEY);
    await expect(verifyMediaCapability(issued.token, now, KEY)).resolves.toEqual(claims);
  });

  it.each([
    ["an extra representation claim", {
      ...v2Claims,
      representation: { ...v2Claims.representation, extra: true },
    }],
    ["more than ten frames", {
      ...v2Claims,
      representation: { ...v2Claims.representation, maxFrames: 11 },
    }],
    ["the wrong purpose", { ...v2Claims, purpose: "other" }],
    ["the wrong version", { ...v2Claims, v: 3 }],
    ["a 601-second lifetime", { ...v2Claims, exp: 1_788_350_201 }],
  ] as const)("rejects a crafted version-2 capability with %s", async (_case, payload) => {
    const now = new Date("2026-09-01T12:00:00Z");
    const issuedAt = Math.floor(now.getTime() / 1000);
    const token = await new EncryptJWT({ ...payload, iat: issuedAt })
      .setProtectedHeader({ alg: "dir", enc: "A256GCM", typ: "JWT" })
      .setIssuedAt(issuedAt)
      .setExpirationTime("exp" in payload ? payload.exp : issuedAt + 600)
      .encrypt(KEY);

    await expect(verifyMediaCapability(token, now, KEY)).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      message: "The media link is invalid or expired",
    });
  });
});
