import { describe, expect, it } from "vitest";
import { decodeProtectedHeader, EncryptJWT, jwtDecrypt } from "jose";
import {
  issueMediaToken,
  verifyMediaToken,
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
});
