import { z } from "zod";

export const healthTelegramSchema = z.object({
  connected: z.boolean(),
  sessionFingerprint: z.string().regex(/^[0-9a-f]{16}$/),
  authorizationCount: z.number().int().nonnegative(),
  lastErrorClass: z.string().nullable(),
});

export const healthPayloadSchema = z.object({
  uptimeSeconds: z.number().nonnegative(),
  revision: z.string().min(1),
  telegram: healthTelegramSchema,
});

export type HealthTelegramSnapshot = z.output<typeof healthTelegramSchema>;
export type HealthSnapshot = z.output<typeof healthPayloadSchema>;

export type HealthProvider = {
  getSnapshot(): Promise<HealthSnapshot> | HealthSnapshot;
};

export function createStaticHealthProvider(
  snapshot: HealthSnapshot,
): HealthProvider {
  return {
    getSnapshot() {
      return snapshot;
    },
  };
}
