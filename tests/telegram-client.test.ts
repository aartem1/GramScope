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
    disconnect: vi.fn(async function (this: TelegramLike) {
      this.connected = false;
    }),
    invoke: vi.fn(async () => ({ ok: true })),
    getDialogs: vi.fn(async () => []),
    getEntity: vi.fn(async () => ({})),
    getMessages: vi.fn(async () => []),
    iterDownload: vi.fn(async function* () {}),
    ...overrides,
  } as TelegramLike & {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  };
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

  it("reconnects after the previous call released the connection", async () => {
    const client = fakeClient();
    __setClientFactoryForTests(async () => client);
    await withTelegram(async (c) => c.invoke({}));
    await withTelegram(async (c) => c.invoke({}));
    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(client.disconnect).toHaveBeenCalledTimes(2);
  });

  it("builds the client only once across calls", async () => {
    const factory = vi.fn(async () => fakeClient());
    __setClientFactoryForTests(factory);
    await withTelegram(async () => undefined);
    await withTelegram(async () => undefined);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("constructs only one client when two calls start on a cold instance", async () => {
    let release!: (client: TelegramLike) => void;
    const held = new Promise<TelegramLike>((resolve) => {
      release = resolve;
    });
    const factory = vi.fn(() => held);
    const client = fakeClient();
    __setClientFactoryForTests(factory);

    const first = withTelegram(async (c) => c.invoke({}));
    const second = withTelegram(async (c) => c.invoke({}));
    await Promise.resolve();
    release(client);
    await Promise.all([first, second]);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("shares one connection across overlapping calls and disconnects once", async () => {
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const client = fakeClient();
    __setClientFactoryForTests(async () => client);

    const first = withTelegram(async () => firstHeld);
    await vi.waitFor(() => expect(client.connect).toHaveBeenCalledTimes(1));
    const second = withTelegram(async () => undefined);
    await Promise.resolve();
    expect(client.disconnect).not.toHaveBeenCalled();
    releaseFirst();
    await Promise.all([first, second]);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.disconnect).toHaveBeenCalledTimes(1);
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

  it("drops a cached client after AUTH_KEY_DUPLICATED so the next call rebuilds", async () => {
    const dead = fakeClient({
      invoke: vi.fn(async () => {
        throw Object.assign(new Error("AUTH_KEY_DUPLICATED"), {
          errorMessage: "AUTH_KEY_DUPLICATED",
        });
      }),
    });
    const healthy = fakeClient();
    const factory = vi
      .fn<() => Promise<TelegramLike>>()
      .mockResolvedValueOnce(dead)
      .mockResolvedValueOnce(healthy);
    __setClientFactoryForTests(factory);

    const error = await withTelegram(async (c) => c.invoke({})).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(GramScopeError);
    expect((error as GramScopeError).code).toBe("AUTH_REQUIRED");
    await withTelegram(async (c) => c.invoke({}));
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
