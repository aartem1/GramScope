import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig(({ mode }) => ({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Load .env.local into the test environment. The live suite reads
    // TELEGRAM_SESSION from process.env, and nothing else populates it —
    // vitest does not read dotenv files on its own. Returns {} when the file
    // is absent, so the fast tier stays independent of it.
    env: loadEnv(mode, process.cwd(), ""),
    // The live suite talks to Telegram over MTProto: a single test can make
    // dozens of round trips, which the 5s default cuts off mid-flight and
    // reports as a failure of the code rather than of the budget.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // Every live test file mutates the same real Telegram account (folders,
    // membership, unread flags), so concurrent files are a structural hazard,
    // not just a slowdown: one file's write can be observed mid-flight by
    // another file's read assertion. GRAMSCOPE_LIVE=1 is already the flag
    // that gates the live suites themselves (see tests/live/*.live.test.ts),
    // so it doubles as the scope for this — the fast tier, which never sets
    // it, keeps running its files in parallel.
    fileParallelism: process.env.GRAMSCOPE_LIVE !== "1",
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
}));
