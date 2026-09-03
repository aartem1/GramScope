import { planGetMedia } from "../src/media/service.js";
import { loadWorkerConfig } from "../src/worker/config.js";
import { createDispatcher } from "../src/ops/dispatch.js";
import { OPERATIONS } from "../src/ops/registry.js";
import type { OperationRegistry } from "../src/ops/dispatch.js";
import {
  holdTelegramConnection,
  startTelegramLiveness,
  stopTelegramLiveness,
} from "../src/telegram/client.js";
import { listenWorkerServer } from "./server.js";
import { createTelegramHealthProvider } from "./telegram-health.js";

function workerOperations(): OperationRegistry {
  return {
    ...OPERATIONS,
    get_media: {
      ...OPERATIONS.get_media,
      // Plan only: MEDIA_TOKEN_SECRET must not live on the worker.
      handler: (input) =>
        planGetMedia(OPERATIONS.get_media.input.parse(input)),
    },
  };
}

async function main(): Promise<void> {
  const config = await loadWorkerConfig();
  const startedAtMs = Date.now();
  const operations = workerOperations();
  const dispatch = createDispatcher(operations);
  const healthProvider = createTelegramHealthProvider({
    session: config.telegramSession,
    revision: config.revision,
    startedAtMs,
  });

  const handle = await listenWorkerServer({
    host: config.host,
    port: config.port,
    bearerToken: config.workerToken,
    tls: {
      caPem: config.caPem,
      serverCertPem: config.serverCertPem,
      serverKeyPem: config.serverKeyPem,
    },
    dispatch,
    registeredOperations: new Set(Object.keys(operations)),
    healthProvider,
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`Received ${signal}; shutting down worker`);
    stopTelegramLiveness();
    await handle.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  console.log(
    `GramScope worker listening on ${config.host}:${handle.port} (revision ${config.revision})`,
  );

  await holdTelegramConnection();
  startTelegramLiveness();
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
