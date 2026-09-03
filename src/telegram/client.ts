import { AsyncLocalStorage } from "node:async_hooks";
import { loadTelegramConfig } from "../config";
import { GramScopeError } from "../errors/taxonomy";
import {
  isDeadTelegramSession,
  isUnresolvedEntity,
  mapTelegramError,
  telegramErrorCode,
} from "../errors/from-telegram";
import { peerKind } from "../peer-id";

export type TelegramLike = {
  connected?: boolean;
  connect(): Promise<boolean>;
  /**
   * Closes the MTProto TCP session. Optional on test doubles that never open
   * a real socket; production teleproto clients always implement it.
   */
  disconnect?(): Promise<void>;
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
    params?: { offset?: number; limit?: number; requestSize?: number; signal?: AbortSignal },
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

// One process holds one MTProto socket for its lifetime. Overlapping calls
// share it via `leases` (concurrency accounting only). releaseClient no longer
// disconnects: a second connection from Vercel, live tests, or a second
// worker would destroy the auth key. AUTH_KEY_* / SESSION_REVOKED freeze the
// process in an unhealthy state instead of reconnecting with a dead key.
let cached: TelegramLike | undefined;
let leases = 0;
let connecting: Promise<TelegramLike> | undefined;
let disconnecting: Promise<void> | undefined;
let testFactory: TestFactory | undefined;
let unhealthy = false;
let lastPersistenceErrorClass: string | null = null;
let livenessTimer: ReturnType<typeof setInterval> | undefined;

const DEFAULT_LIVENESS_INTERVAL_MS = 30_000;
const MAX_CONNECT_ATTEMPTS = 8;
const BACKOFF_CAP_MS = 30_000;

type PersistenceHooks = {
  sleep?: (ms: number) => Promise<void>;
  ping?: (client: TelegramLike) => Promise<void>;
};

let persistenceHooks: PersistenceHooks | undefined;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, BACKOFF_CAP_MS);
}

function markUnhealthy(): void {
  unhealthy = true;
  lastPersistenceErrorClass = "AUTH_REQUIRED";
}

export function getTelegramPersistenceState(): {
  unhealthy: boolean;
  lastErrorClass: string | null;
} {
  return { unhealthy, lastErrorClass: lastPersistenceErrorClass };
}

export function __setTelegramPersistenceForTests(
  hooks: PersistenceHooks | undefined,
): void {
  persistenceHooks = hooks;
}

async function pingClient(client: TelegramLike): Promise<void> {
  if (persistenceHooks?.ping) {
    await persistenceHooks.ping(client);
    return;
  }
  const Api = await getApi();
  await client.invoke(new Api.help.GetNearestDc());
}

const defaultFactory: Factory = async () => {
  const config = loadTelegramConfig();
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
  if (livenessTimer !== undefined) {
    clearInterval(livenessTimer);
    livenessTimer = undefined;
  }
  cached = undefined;
  leases = 0;
  connecting = undefined;
  disconnecting = undefined;
  unhealthy = false;
  lastPersistenceErrorClass = null;
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

async function acquireClient(): Promise<TelegramLike> {
  if (unhealthy) {
    throw new GramScopeError(
      "AUTH_REQUIRED",
      "Telegram session is no longer valid.",
      undefined,
      false,
    );
  }
  if (disconnecting) await disconnecting;

  leases += 1;
  try {
    if (cached?.connected) return cached;
    connecting ??= (async () => {
      const factory = testFactory ?? defaultFactory;
      let client = cached;
      if (!client) {
        client = (await factory()) as TelegramLike;
        client.onError = recordSwallowedError;
        cached = client;
      }
      const sleep = persistenceHooks?.sleep ?? defaultSleep;
      for (let attempt = 0; attempt < MAX_CONNECT_ATTEMPTS; attempt++) {
        try {
          if (!client.connected) await client.connect();
          return client;
        } catch (err) {
          if (isDeadTelegramSession(err)) {
            markUnhealthy();
            throw err;
          }
          if (attempt + 1 >= MAX_CONNECT_ATTEMPTS) throw err;
          await sleep(backoffMs(attempt));
        }
      }
      throw new Error("Telegram connect retries exhausted");
    })().finally(() => {
      connecting = undefined;
    });
    return await connecting;
  } catch (err) {
    leases -= 1;
    if (isDeadTelegramSession(err)) {
      cached = undefined;
    }
    throw err;
  }
}

async function releaseClient(client: TelegramLike, drop: boolean): Promise<void> {
  leases -= 1;
  if (!drop) return;
  markUnhealthy();
  cached = undefined;
  disconnecting = Promise.resolve(client.disconnect?.())
    .catch(() => undefined)
    .finally(() => {
      disconnecting = undefined;
    });
  await disconnecting;
}

export function startTelegramLiveness(
  options: { intervalMs?: number } = {},
): void {
  if (livenessTimer !== undefined) clearInterval(livenessTimer);
  const intervalMs = options.intervalMs ?? DEFAULT_LIVENESS_INTERVAL_MS;
  livenessTimer = setInterval(() => {
    void tickLiveness();
  }, intervalMs);
}

export function stopTelegramLiveness(): void {
  if (livenessTimer === undefined) return;
  clearInterval(livenessTimer);
  livenessTimer = undefined;
}

/** Close the held socket on process shutdown so a restart does not overlap. */
export async function shutdownTelegramConnection(): Promise<void> {
  stopTelegramLiveness();
  const client = cached;
  cached = undefined;
  leases = 0;
  connecting = undefined;
  await Promise.resolve(client?.disconnect?.()).catch(() => undefined);
}

export async function __tickTelegramLivenessForTests(): Promise<void> {
  await tickLiveness();
}

async function tickLiveness(): Promise<void> {
  if (unhealthy || leases > 0 || !cached?.connected) return;
  try {
    await pingClient(cached);
  } catch (err) {
    if (isDeadTelegramSession(err)) {
      markUnhealthy();
      const client = cached;
      cached = undefined;
      await Promise.resolve(client?.disconnect?.()).catch(() => undefined);
      return;
    }
    if (cached) cached.connected = false;
  }
}

/**
 * Open the MTProto socket at worker process start and keep probing it.
 * AUTH_KEY failures must not exit the process.
 */
export async function holdTelegramConnection(): Promise<void> {
  try {
    await withTelegram(async () => undefined);
  } catch (err) {
    if (err instanceof GramScopeError && err.code === "AUTH_REQUIRED") {
      console.error("Telegram session is invalid; refusing operations until login");
      return;
    }
    console.error("Telegram connect failed; will retry on the next operation");
  }
}

/**
 * The only path to MTProto. No tool may import a Telegram client directly.
 */
export type TelegramLoginCallbacks = {
  phoneNumber(): Promise<string>;
  phoneCode(): Promise<string>;
  password(): Promise<string>;
  onError?(err: Error): void;
};

/**
 * Interactive Telegram login for the worker entry point. Only client.ts may
 * import teleproto; scripts reach login through this helper.
 */
export async function loginTelegramSession(
  apiId: number,
  apiHash: string,
  callbacks: TelegramLoginCallbacks,
): Promise<string> {
  const { TelegramClient } = await import("teleproto");
  const { StringSession } = await import("teleproto/sessions");
  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 3,
  });

  try {
    await client.start({
      phoneNumber: callbacks.phoneNumber,
      phoneCode: callbacks.phoneCode,
      password: callbacks.password,
      onError: (err) => {
        callbacks.onError?.(err);
      },
    });

    const session = client.session.save();
    if (typeof session !== "string" || session.length === 0) {
      throw new Error("Telegram returned an empty session string");
    }
    return session;
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

export async function withTelegram<T>(
  fn: (client: TelegramLike) => Promise<T>,
): Promise<T> {
  let client: TelegramLike;
  try {
    client = await acquireClient();
  } catch (err) {
    throw mapTelegramError(err);
  }

  let drop = false;
  try {
    return await fn(client);
  } catch (err) {
    drop = isDeadTelegramSession(err);
    throw mapTelegramError(err);
  } finally {
    await releaseClient(client, drop);
  }
}
