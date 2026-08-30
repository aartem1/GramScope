import { AsyncLocalStorage } from "node:async_hooks";
import { loadConfig } from "../config";
import {
  isUnresolvedEntity,
  mapTelegramError,
  telegramErrorCode,
} from "../errors/from-telegram";
import { peerKind } from "./peer-id";

export type TelegramLike = {
  connected?: boolean;
  connect(): Promise<boolean>;
  invoke(request: unknown): Promise<unknown>;
  /**
   * teleproto's public error hook (`set onError` on TelegramBaseClient). It is
   * awaited from inside the catch blocks where teleproto swallows an error
   * rather than rethrowing it, which is the only way to see those errors from
   * outside the library. withTelegram installs one; see resolveEntity.
   */
  onError?: (err: unknown) => void | Promise<void>;
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
  iterDownload(
    file: unknown,
    params?: { offset?: number; limit?: number; requestSize?: number },
  ): AsyncGenerator<Buffer, void, unknown>;
};

type Factory = () => Promise<TelegramLike>;
// Existing unit suites provide partial client doubles to exercise operations
// unrelated to downloads. Keep that test-only seam compatible while the
// production TelegramLike contract remains strict for media consumers.
type TestFactory = () => Promise<
  Omit<TelegramLike, "iterDownload"> & Partial<Pick<TelegramLike, "iterDownload">>
>;

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
let testFactory: TestFactory | undefined;

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

export function __setClientFactoryForTests(factory: TestFactory | undefined): void {
  testFactory = factory;
}

export function __resetClientForTests(): void {
  cached = undefined;
}

/**
 * One box per entity resolution. AsyncLocalStorage rather than a module-level
 * field because get_messages fans out up to 25 source resolutions over one
 * shared client (FANOUT_CONCURRENCY at a time): a single "last swallowed error"
 * would attach one source's rate limit to another source's result. The store
 * propagates across awaits into teleproto's own catch block and nowhere else,
 * so each resolution reads only its own error. Node >= 20 is required by
 * package.json and this app declares no Edge runtime, the same basis on which
 * node:crypto was accepted in Task 2.
 */
type SwallowedErrorBox = { error?: unknown };

const swallowed = new AsyncLocalStorage<SwallowedErrorBox>();

/**
 * Never throws: teleproto awaits this inside a catch, and a throw here would be
 * rewritten into a different error by its onError wrapper. Never logs either —
 * the object may be an RPCError whose payload carries request parameters.
 */
function recordSwallowedError(err: unknown): void {
  const box = swallowed.getStore();
  // Last one wins: it is the failure immediately preceding teleproto's generic
  // throw, hence the one that explains it.
  if (box) box.error = err;
}

/**
 * Decides what a failed resolution should actually report.
 *
 * teleproto's `_getInputEntity` catches everything `channels.getChannels`
 * raises — CHANNEL_INVALID, FLOOD_WAIT, AUTH_KEY_UNREGISTERED, a socket error —
 * without discriminating, and replaces it with one generic
 * "Could not find the input entity" Error (client/users.js, the PeerChannel
 * branch). Classifying that generic error as CHANNEL_NOT_FOUND is right only
 * for CHANNEL_INVALID; for a rate limit it is wrong in the actionable
 * direction, telling a caller to drop a source that merely needs a retry.
 *
 * So: when the generic error is what surfaced and we captured the real one,
 * the real one is rethrown in its place. CHANNEL_INVALID is left to the
 * generic path on purpose — mapTelegramError turns that into a
 * CHANNEL_NOT_FOUND whose message names the fix (address the peer by
 * @username), which "Telegram error: CHANNEL_INVALID" would not.
 */
function resolutionFailure(thrown: unknown, captured: unknown): unknown {
  if (captured === undefined) return thrown;
  if (!isUnresolvedEntity(thrown)) return thrown;
  if (telegramErrorCode(captured) === "CHANNEL_INVALID") return thrown;
  return captured;
}

/**
 * The only way any module may turn a name into an entity. It is a plain
 * `client.getEntity` plus the capture above; call it instead of
 * `client.getEntity` so a swallowed failure is never misreported.
 *
 * The rethrown error still passes through mapTelegramError before it reaches a
 * caller, so a captured error's free-text message is dropped and only an
 * UPPER_SNAKE code is ever echoed — nothing a captured object carries can
 * escape into a response or a log line.
 */
export async function resolveEntity(
  client: TelegramLike,
  target: string,
): Promise<Record<string, unknown>> {
  const box: SwallowedErrorBox = {};
  try {
    return await swallowed.run(box, () => client.getEntity(target));
  } catch (err) {
    throw resolutionFailure(err, box.error);
  }
}

/**
 * Builds the `InputPeer` a TL request wants from a resolved entity.
 *
 * Most requests do not need this: teleproto converts an `Api.Channel` into an
 * `InputChannel` on its own when the parameter is typed as one, which is why
 * markRead never built a peer. `messages.MarkDialogUnread` and
 * `messages.UpdateDialogFilter` take `InputDialogPeer` and `Vector<InputPeer>`
 * respectively, and neither is converted for us.
 *
 * Lives here rather than in peer-id.ts because this module is the only one
 * permitted to reach the TL namespace; the kind discrimination is peer-id's.
 */
export async function toInputPeer(entity: unknown): Promise<unknown> {
  const Api = await getApi();
  const e = (entity ?? {}) as Record<string, unknown>;
  switch (peerKind(entity)) {
    case "channel":
      return new Api.InputPeerChannel({
        channelId: e.id as never,
        accessHash: (e.accessHash ?? 0) as never,
      });
    case "chat":
      return new Api.InputPeerChat({ chatId: e.id as never });
    default:
      return new Api.InputPeerUser({
        userId: e.id as never,
        accessHash: (e.accessHash ?? 0) as never,
      });
  }
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
    client = await factory() as TelegramLike;
    // Installed once per client, before it is ever used, so every resolution
    // that runs on it can recover what teleproto swallows. Outside a
    // resolveEntity scope this is a no-op, so the background sender and update
    // loops — which call the same hook — record nothing.
    client.onError = recordSwallowedError;
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
