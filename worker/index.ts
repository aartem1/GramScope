import { loadWorkerConfig } from "../src/worker/config.js";
import { createDispatcher } from "../src/ops/dispatch.js";
import { OPERATIONS } from "../src/ops/registry.js";
import { listenWorkerServer } from "./server.js";
import { createTelegramHealthProvider } from "./telegram-health.js";

async function main(): Promise<void> {
  const config = await loadWorkerConfig();
  const startedAtMs = Date.now();
  const dispatch = createDispatcher(OPERATIONS);
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
    registeredOperations: new Set(Object.keys(OPERATIONS)),
    healthProvider,
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`Received ${signal}; shutting down worker`);
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
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
