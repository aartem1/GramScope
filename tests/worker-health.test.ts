import { describe, expect, it } from "vitest";
import {
  createStaticHealthProvider,
  healthPayloadSchema,
} from "../worker/health";

describe("worker health payload", () => {
  it("accepts revision and authorization count and rejects secret fields", () => {
    const snapshot = {
      uptimeSeconds: 12,
      revision: "abc1234",
      telegram: {
        connected: true,
        sessionFingerprint: "0123456789abcdef",
        authorizationCount: 1,
        lastErrorClass: null,
      },
    };

    expect(healthPayloadSchema.parse(snapshot)).toEqual(snapshot);

    const provider = createStaticHealthProvider(snapshot);
    expect(provider.getSnapshot()).toEqual(snapshot);

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("TELEGRAM_SESSION");
    expect(serialized).not.toContain("Bearer");
  });
});
