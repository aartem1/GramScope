import { afterEach, describe, expect, it } from "vitest";
import {
  __resetDiscoveryCacheForTests,
  enrichCandidates,
  MAX_ENRICHED_CANDIDATES,
  toCandidate,
} from "@/telegram/discovery";
import type { DialogIndex } from "@/telegram/dialog-index";
import type { TelegramLike } from "@/telegram/client";

afterEach(() => {
  __resetDiscoveryCacheForTests();
});

const HELD = "-1001111111111";

function index(ids: string[] = []): DialogIndex {
  return {
    byId: new Map(
      ids.map((id) => [
        id,
        {
          source_id: id,
          title: "Held",
          unread_count: 0,
          read_inbox_max_id: 0,
          folder_ids: [],
        },
      ]),
    ),
    folders: [],
  };
}

function channel(over: Record<string, unknown> = {}) {
  return {
    className: "Channel",
    id: 1111111111n,
    title: "Alpha News",
    broadcast: true,
    participantsCount: 4874,
    ...over,
  };
}

describe("toCandidate", () => {
  it("reads a live handle out of usernames[] when username is null", () => {
    // Measured 2026-08-28: contacts.search returns username: null for
    // collectible handles and puts the live one in usernames[].
    const candidate = toCandidate(
      channel({
        username: null,
        usernames: [{ username: "alpha_news", active: true }],
      }),
      index(),
    );
    expect(candidate.username).toBe("alpha_news");
    expect(candidate.url).toBe("https://t.me/alpha_news");
  });

  it("reports joined from the dialog index, not from the left flag", () => {
    // A stale `left` is exactly the disagreement this pins: the index is the
    // same authority every other tool means by "this account holds it".
    const held = toCandidate(channel({ left: true }), index([HELD]));
    const stranger = toCandidate(channel({ left: false }), index([]));
    expect(held.joined).toBe(true);
    expect(stranger.joined).toBe(false);
  });

  it("states every trust flag as a boolean, never as an absent key", () => {
    const clean = toCandidate(channel(), index());
    expect(clean).toMatchObject({
      verified: false,
      scam: false,
      fake: false,
      restricted: false,
    });
    const bad = toCandidate(
      channel({ scam: true, fake: true, restricted: true, verified: true }),
      index(),
    );
    expect(bad).toMatchObject({
      verified: true,
      scam: true,
      fake: true,
      restricted: true,
    });
  });

  it("prefers a fetched description over the entity's own about", () => {
    const candidate = toCandidate(channel({ about: "stale" }), index(), {
      description: "fetched",
    });
    expect(candidate.description).toBe("fetched");
  });

  it("carries id, title, type and subscriber count", () => {
    expect(toCandidate(channel({ username: "alpha" }), index())).toMatchObject({
      id: HELD,
      title: "Alpha News",
      type: "channel",
      subscriber_count: 4874,
      username: "alpha",
    });
  });
});

function fullChannelClient(reply: (channelId: string) => unknown): {
  client: TelegramLike;
  calls: string[];
  inFlight: () => number;
} {
  const calls: string[] = [];
  let live = 0;
  let peak = 0;
  const client = {
    connected: true,
    connect: async () => true,
    getDialogs: async () => [],
    getEntity: async () => ({}),
    getMessages: async () => [],
    invoke: async (request: unknown) => {
      const channel = (request as { channel?: { id?: unknown } }).channel;
      const id = String((channel as { id?: unknown })?.id ?? "");
      calls.push(id);
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((resolve) => setTimeout(resolve, 5));
      live -= 1;
      return reply(id);
    },
  } as unknown as TelegramLike;
  return { client, calls, inFlight: () => peak };
}

function fullChannel(about: string) {
  return { fullChat: { about } };
}

function entities(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    className: "Channel",
    id: BigInt(1000000000 + i),
    title: `C${i}`,
  }));
}

describe("enrichCandidates", () => {
  it("never issues more than the flood ceiling of requests", async () => {
    const { client, calls } = fullChannelClient(() => fullChannel("about"));
    await enrichCandidates(client, entities(40));
    expect(MAX_ENRICHED_CANDIDATES).toBe(10);
    expect(calls.length).toBe(MAX_ENRICHED_CANDIDATES);
  });

  it("keeps at most three requests in flight", async () => {
    const { client, inFlight } = fullChannelClient(() => fullChannel("about"));
    await enrichCandidates(client, entities(10));
    expect(inFlight()).toBeLessThanOrEqual(3);
  });

  it("serves a repeat candidate from the instance cache", async () => {
    const { client, calls } = fullChannelClient(() => fullChannel("about"));
    const list = entities(3);
    await enrichCandidates(client, list);
    await enrichCandidates(client, list);
    expect(calls.length).toBe(3);
  });

  it("does not cache a failure, so one flood is not permanent", async () => {
    let fail = true;
    const { client, calls } = fullChannelClient(() => {
      if (fail) throw new Error("FLOOD_WAIT_27");
      return fullChannel("about");
    });
    const list = entities(1);
    expect((await enrichCandidates(client, list))[0]).toEqual({});
    fail = false;
    expect((await enrichCandidates(client, list))[0]).toMatchObject({
      description: "about",
    });
    expect(calls.length).toBe(2);
  });

  it("isolates one failure to one candidate", async () => {
    const { client } = fullChannelClient((id) => {
      if (id === "1000000001") throw new Error("CHANNEL_PRIVATE");
      return fullChannel("about");
    });
    const details = await enrichCandidates(client, entities(3));
    expect(details.map((d) => d.description)).toEqual([
      "about",
      undefined,
      "about",
    ]);
  });
});
