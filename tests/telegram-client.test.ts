import { afterEach, describe, expect, it, vi } from "vitest";
import {
  withTelegram,
  __setClientFactoryForTests,
  __resetClientForTests,
  type TelegramLike,
} from "@/telegram/client";
import { GramScopeError } from "@/errors/taxonomy";

function fakeClient(overrides: Partial<TelegramLike> = {}) {
  return {
    connected: false,
    connect: vi.fn(async function (this: TelegramLike) {
      this.connected = true;
      return true;
    }),
    invoke: vi.fn(async () => ({ ok: true })),
    getDialogs: vi.fn(async () => []),
    getEntity: vi.fn(async () => ({})),
    ...overrides,
  } as TelegramLike & { connect: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  __resetClientForTests();
  __setClientFactoryForTests(undefined);
});

describe("withTelegram", () => {
  it("connects on a cold instance", async () => {
    const client = fakeClient();
    __setClientFactoryForTests(async () => client);
    await withTelegram(async (c) => c.invoke({}));
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it("reuses a warm client without reconnecting", async () => {
    const client = fakeClient();
    __setClientFactoryForTests(async () => client);
    await withTelegram(async (c) => c.invoke({}));
    await withTelegram(async (c) => c.invoke({}));
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it("builds the client only once across calls", async () => {
    const factory = vi.fn(async () => fakeClient());
    __setClientFactoryForTests(factory);
    await withTelegram(async () => undefined);
    await withTelegram(async () => undefined);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("translates Telegram failures into the taxonomy", async () => {
    const client = fakeClient({
      invoke: vi.fn(async () => {
        throw Object.assign(new Error("FLOOD_WAIT_7"), {
          errorMessage: "FLOOD_WAIT_7",
        });
      }),
    });
    __setClientFactoryForTests(async () => client);

    const error = await withTelegram(async (c) => c.invoke({})).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(GramScopeError);
    expect((error as GramScopeError).code).toBe("RATE_LIMITED");
    expect((error as GramScopeError).retryAfterSeconds).toBe(7);
  });

  it("drops a cached client whose connection failed, so the next call rebuilds", async () => {
    const failing = fakeClient({
      connect: vi.fn(async () => {
        throw Object.assign(new Error("AUTH_KEY_UNREGISTERED"), {
          errorMessage: "AUTH_KEY_UNREGISTERED",
        });
      }),
    });
    const healthy = fakeClient();
    const factory = vi
      .fn<() => Promise<TelegramLike>>()
      .mockResolvedValueOnce(failing)
      .mockResolvedValueOnce(healthy);
    __setClientFactoryForTests(factory);

    await expect(withTelegram(async () => undefined)).rejects.toBeInstanceOf(
      GramScopeError,
    );
    await withTelegram(async () => undefined);
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
