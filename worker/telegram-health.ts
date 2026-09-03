import { GramScopeError } from "../src/errors/taxonomy";
import { mapTelegramError } from "../src/errors/from-telegram";
import { sessionFingerprint } from "../src/session/fingerprint";
import { getApi, withTelegram, type TelegramLike } from "../src/telegram/client";
import type { HealthProvider, HealthSnapshot } from "./health";

const DEFAULT_AUTHORIZATION_CACHE_MS = 60_000;

type TelegramHealthProviderOptions = {
  session: string;
  revision: string;
  startedAtMs: number;
  now?: () => number;
  authorizationCacheMs?: number;
};

async function fetchAuthorizationCount(client: TelegramLike): Promise<number> {
  const Api = await getApi();
  const result = (await client.invoke(
    new Api.account.GetAuthorizations(),
  )) as { authorizations?: unknown[] };
  return Array.isArray(result.authorizations)
    ? result.authorizations.length
    : 0;
}

export function createTelegramHealthProvider(
  options: TelegramHealthProviderOptions,
): HealthProvider {
  const now = options.now ?? Date.now;
  const authorizationCacheMs =
    options.authorizationCacheMs ?? DEFAULT_AUTHORIZATION_CACHE_MS;
  let cachedAuthorizationCount = 0;
  let cachedAtMs = 0;
  let lastErrorClass: string | null = null;

  return {
    async getSnapshot(): Promise<HealthSnapshot> {
      let connected = false;
      let authorizationCount = cachedAuthorizationCount;

      try {
        await withTelegram(async (client) => {
          connected = client.connected === true;
          const ageMs = now() - cachedAtMs;
          if (ageMs >= authorizationCacheMs) {
            cachedAuthorizationCount = await fetchAuthorizationCount(client);
            cachedAtMs = now();
          }
          authorizationCount = cachedAuthorizationCount;
          lastErrorClass = null;
        });
      } catch (err) {
        const mapped =
          err instanceof GramScopeError ? err : mapTelegramError(err);
        lastErrorClass = mapped.code;
      }

      return {
        uptimeSeconds: Math.floor((now() - options.startedAtMs) / 1000),
        revision: options.revision,
        telegram: {
          connected,
          sessionFingerprint: sessionFingerprint(options.session),
          authorizationCount,
          lastErrorClass,
        },
      };
    },
  };
}
