import { loadConfig } from "../config";
import { mapTelegramError } from "../errors/from-telegram";

export type TelegramLike = {
  connected?: boolean;
  connect(): Promise<boolean>;
  invoke(request: unknown): Promise<unknown>;
  /**
   * Returns teleproto's TotalList — an Array subclass carrying a `total`
   * property — not a plain array. filter, map and slice preserve the subclass
   * through Symbol.species, so normalize with Array.from before the value
   * reaches a domain result. JSON.stringify drops `total`, so a leak is
   * invisible on the wire and to any fake that returns a plain array — which
   * most of them do. Only a structural comparison catches it; see the
   * TotalList regressions in tests/telegram-{dialogs,messages}.test.ts.
   */
  getDialogs(params: Record<string, unknown>): Promise<unknown[]>;
  getEntity(entity: string): Promise<Record<string, unknown>>;
  /** Returns a TotalList; see the note on getDialogs. */
  getMessages(
    entity: string,
    params: Record<string, unknown>,
  ): Promise<unknown[]>;
};

type Factory = () => Promise<TelegramLike>;

type ApiNamespace = (typeof import("teleproto"))["Api"];

let apiNamespace: ApiNamespace | undefined;

/**
 * The TL request namespace. This module is the ONLY one permitted to import
 * teleproto; every other module reaches MTProto through withTelegram and this
 * accessor, so the client can be swapped or faked in one place.
 */
export async function getApi(): Promise<ApiNamespace> {
  apiNamespace ??= (await import("teleproto")).Api;
  return apiNamespace;
}

// Module scope: on a warm Vercel instance this survives between invocations,
// which is the point — a fresh MTProto handshake per tool call is wasteful and
// invites FLOOD_WAIT.
let cached: TelegramLike | undefined;
let testFactory: Factory | undefined;

const defaultFactory: Factory = async () => {
  const config = loadConfig();
  const { TelegramClient } = await import("teleproto");
  const { StringSession } = await import("teleproto/sessions");
  return new TelegramClient(
    new StringSession(config.telegramSession),
    config.telegramApiId,
    config.telegramApiHash,
    { connectionRetries: 3 },
  ) as unknown as TelegramLike;
};

export function __setClientFactoryForTests(factory: Factory | undefined): void {
  testFactory = factory;
}

export function __resetClientForTests(): void {
  cached = undefined;
}

/**
 * The only path to MTProto. No tool may import a Telegram client directly.
 */
export async function withTelegram<T>(
  fn: (client: TelegramLike) => Promise<T>,
): Promise<T> {
  const factory = testFactory ?? defaultFactory;

  let client = cached;
  if (!client) {
    client = await factory();
    cached = client;
  }

  try {
    if (!client.connected) await client.connect();
  } catch (err) {
    // A client that cannot connect must not be reused.
    cached = undefined;
    throw mapTelegramError(err);
  }

  try {
    return await fn(client);
  } catch (err) {
    throw mapTelegramError(err);
  }
}
