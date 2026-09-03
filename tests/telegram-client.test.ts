import { afterEach, describe, expect, it, vi } from "vitest";
import {
  withTelegram,
  startTelegramLiveness,
  getTelegramPersistenceState,
  __setClientFactoryForTests,
  __resetClientForTests,
  __setTelegramPersistenceForTests,
  __tickTelegramLivenessForTests,
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
    invoke: ReturnType<typeof vi.fn>;
  };
}

afterEach(() => {
  __resetClientForTests();
  __setClientFactoryForTests(undefined);
  __setTelegramPersistenceForTests(undefined);
});

describe("withTelegram persistent connection", () => {
  it("connects on a cold instance", async () => {
    const client = fakeClient();
    __setClientFactoryForTests(async () => client);
    await withTelegram(async (c) => c.invoke({}));
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it("keeps the socket open between sequential operations", async () => {
    const client = fakeClient();
    __setClientFactoryForTests(async () => client);
    await withTelegram(async (c) => c.invoke({}));
    await withTelegram(async (c) => c.invoke({}));
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.disconnect).not.toHaveBeenCalled();
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

  it("shares one connection across overlapping calls and does not disconnect", async () => {
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
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it("reconnects after a dropped socket without building a new client", async () => {
    const client = fakeClient();
    __setClientFactoryForTests(async () => client);
    await withTelegram(async (c) => c.invoke({}));
    client.connected = false;
    await withTelegram(async (c) => c.invoke({}));
    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it("retries connect with bounded backoff after a transient drop", async () => {
    const sleeps: number[] = [];
    __setTelegramPersistenceForTests({
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const client = fakeClient({
      connect: vi.fn(async function (this: TelegramLike) {
        const calls = (this.connect as ReturnType<typeof vi.fn>).mock.calls.length;
        if (calls < 3) {
          throw new Error("ECONNRESET");
        }
        this.connected = true;
        return true;
      }),
    });
    __setClientFactoryForTests(async () => client);
    await withTelegram(async () => undefined);
    expect(sleeps).toEqual([1000, 2000]);
    expect(client.connected).toBe(true);
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

  it("enters unhealthy state on a dead auth key and refuses later operations", async () => {
    const dead = fakeClient({
      invoke: vi.fn(async () => {
        throw Object.assign(new Error("AUTH_KEY_DUPLICATED"), {
          errorMessage: "AUTH_KEY_DUPLICATED",
        });
      }),
    });
    const factory = vi.fn(async () => dead);
    __setClientFactoryForTests(factory);

    const error = await withTelegram(async (c) => c.invoke({})).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(GramScopeError);
    expect((error as GramScopeError).code).toBe("AUTH_REQUIRED");
    expect(getTelegramPersistenceState()).toEqual({
      unhealthy: true,
      lastErrorClass: "AUTH_REQUIRED",
    });

    const again = await withTelegram(async (c) => c.invoke({})).catch(
      (e: unknown) => e,
    );
    expect(again).toBeInstanceOf(GramScopeError);
    expect((again as GramScopeError).code).toBe("AUTH_REQUIRED");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("enters unhealthy state when connect fails with AUTH_KEY_UNREGISTERED", async () => {
    const failing = fakeClient({
      connect: vi.fn(async () => {
        throw Object.assign(new Error("AUTH_KEY_UNREGISTERED"), {
          errorMessage: "AUTH_KEY_UNREGISTERED",
        });
      }),
    });
    const factory = vi.fn(async () => failing);
    __setClientFactoryForTests(factory);

    await expect(withTelegram(async () => undefined)).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
    await expect(withTelegram(async () => undefined)).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(getTelegramPersistenceState().unhealthy).toBe(true);
  });
});

describe("Telegram liveness probe", () => {
  it("invokes a lightweight ping while the socket is idle", async () => {
    const client = fakeClient();
    __setClientFactoryForTests(async () => client);
    __setTelegramPersistenceForTests({
      ping: async (target) => {
        await target.invoke({});
      },
    });
    await withTelegram(async () => undefined);
    startTelegramLiveness({ intervalMs: 30_000 });
    await __tickTelegramLivenessForTests();
    expect(client.invoke).toHaveBeenCalled();
  });

  it("marks the connection unhealthy when the ping sees SESSION_REVOKED", async () => {
    const client = fakeClient({
      invoke: vi.fn(async () => {
        throw Object.assign(new Error("SESSION_REVOKED"), {
          errorMessage: "SESSION_REVOKED",
        });
      }),
    });
    __setClientFactoryForTests(async () => client);
    __setTelegramPersistenceForTests({
      ping: async (target) => {
        await target.invoke({});
      },
    });
    await withTelegram(async () => undefined);
    startTelegramLiveness({ intervalMs: 30_000 });
    await __tickTelegramLivenessForTests();
    expect(getTelegramPersistenceState()).toEqual({
      unhealthy: true,
      lastErrorClass: "AUTH_REQUIRED",
    });
  });
});
