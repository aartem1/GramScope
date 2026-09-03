import { access } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("worker build output", () => {
  it("emits the production entry and login script without auto-start side effects", async () => {
    const root = join(import.meta.dirname, "..");
    const workerEntry = join(root, "dist/worker/worker/index.js");
    const loginEntry = join(root, "dist/worker/scripts/create-telegram-session.js");
    const serverModule = join(root, "dist/worker/worker/server.js");

    await expect(access(workerEntry)).resolves.toBeUndefined();
    await expect(access(loginEntry)).resolves.toBeUndefined();
    await expect(access(serverModule)).resolves.toBeUndefined();

    const server = await import(`file://${serverModule.replace(/\\/g, "/")}`);
    expect(typeof server.createWorkerServer).toBe("function");
    expect(typeof server.listenWorkerServer).toBe("function");
  });
});
