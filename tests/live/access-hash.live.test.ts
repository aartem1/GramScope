import { beforeAll, describe, expect, it } from "vitest";
import {
  __resetClientForTests,
  getApi,
  withTelegram,
} from "@/telegram/client";
import { listDialogs } from "@/telegram/dialogs";

const enabled = process.env.GRAMSCOPE_LIVE === "1";
const suite = enabled ? describe : describe.skip;

// Spec §10: the write path is assumed to resolve a peer from a marked id with
// access_hash = 0, exactly as reads do. This file is the observation that
// turns the assumption into a fact, and it runs before anything depends on it.
suite("access-hash resolution on a cold instance", () => {
  beforeAll(() => {
    if (!process.env.TELEGRAM_SESSION) {
      throw new Error("TELEGRAM_SESSION is required for live tests");
    }
  });

  it("accepts channels.readHistory for a peer resolved from a marked id", async () => {
    const { sources } = await listDialogs({ limit: 50, type: "channel" });
    const target = sources.find(
      (s) => typeof s.read_inbox_max_id === "number" && s.read_inbox_max_id > 0,
    );
    if (!target) {
      throw new Error(
        "the account has no channel with a read pointer; open one in Telegram before running this probe",
      );
    }

    // Drop the warm client so the peer must be resolved over the network from
    // its marked id alone. A warm _entityCache would hide the very failure
    // this probe exists to find.
    __resetClientForTests();

    const result = await withTelegram(async (client) => {
      const Api = await getApi();
      const entity = await client.getEntity(target.id);
      expect(entity.className).toBe("Channel");
      // maxId = the pointer's current value: a real write RPC that moves
      // nothing. Telegram still validates the access hash.
      return client.invoke(
        new Api.channels.ReadHistory({
          channel: entity as never,
          maxId: target.read_inbox_max_id!,
        }),
      );
    });

    // channels.readHistory returns Bool: true if the pointer moved, false if
    // it was already at maxId (the no-op case this probe deliberately
    // triggers). Either value proves Telegram accepted the RPC and validated
    // the access hash; only a thrown error (CHANNEL_INVALID and friends)
    // would mean it didn't.
    expect(typeof result).toBe("boolean");
  });
});
