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

import {
  __resetClientForTests,
  __setClientFactoryForTests,
} from "@/telegram/client";
import { searchChannels } from "@/telegram/discovery";

function found(over: Record<string, unknown>) {
  return {
    className: "contacts.Found",
    myResults: [],
    results: [],
    chats: [],
    users: [],
    ...over,
  };
}

function peerChannel(bare: number) {
  return { className: "PeerChannel", channelId: BigInt(bare) };
}

function peerUser(bare: number) {
  return { className: "PeerUser", userId: BigInt(bare) };
}

/**
 * Routes by TL class name, never by the presence of a `channel` field:
 * GetChannelRecommendations carries one too, so a field test would feed the
 * recommendation call the enrichment reply. Requests are stored unspread,
 * because teleproto puts `className` on the prototype.
 */
function requestName(request: unknown): string {
  return String((request as { className?: unknown }).className ?? "");
}

function isEnrichment(request: unknown): boolean {
  return requestName(request).includes("GetFullChannel");
}

function installSearch(reply: unknown) {
  const sent: unknown[] = [];
  __setClientFactoryForTests(async () => ({
    connected: true,
    connect: async () => true,
    getDialogs: async () => [],
    // A Channel entity keyed by the requested username, not {}: Task 4's
    // seeded getSimilarChannels test resolves an unheld @source over the
    // network, which needs resolveEntity to find a marked id.
    getEntity: async (target: string) => ({
      className: "Channel",
      id: 9999999999n,
      title: `Resolved ${target}`,
      username: target,
    }),
    getMessages: async () => [],
    invoke: async (request: unknown) => {
      sent.push(request);
      if (isEnrichment(request)) return { fullChat: { about: "about" } };
      return reply;
    },
  }));
  return sent;
}

afterEach(() => {
  __setClientFactoryForTests(undefined);
  __resetClientForTests();
});

describe("searchChannels", () => {
  it("always asks Telegram for broadcasts only", async () => {
    const sent = installSearch(found({}));
    await searchChannels({ query: "нейросети" });
    const search = sent.find((r) => requestName(r) === "contacts.Search");
    expect(search).toMatchObject({ q: "нейросети", broadcasts: true });
  });

  it("rejects an empty query without calling Telegram", async () => {
    const sent = installSearch(found({}));
    await expect(searchChannels({ query: "   " })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(sent).toEqual([]);
  });

  it("drops user results and keeps channels", async () => {
    installSearch(
      found({
        results: [peerUser(5), peerChannel(1111111111)],
        chats: [{ className: "Channel", id: 1111111111n, title: "Alpha" }],
        users: [{ className: "User", id: 5n, firstName: "Someone" }],
      }),
    );
    const { candidates } = await searchChannels({ query: "alpha" });
    expect(candidates.map((c) => c.title)).toEqual(["Alpha"]);
  });

  it("puts the account's own matches first and lists a peer once", async () => {
    installSearch(
      found({
        myResults: [peerChannel(2222222222)],
        results: [peerChannel(1111111111), peerChannel(2222222222)],
        chats: [
          { className: "Channel", id: 1111111111n, title: "Stranger" },
          { className: "Channel", id: 2222222222n, title: "Mine" },
        ],
      }),
    );
    const { candidates } = await searchChannels({ query: "x" });
    expect(candidates.map((c) => c.title)).toEqual(["Mine", "Stranger"]);
  });

  it("reports truncated at Telegram's cap of ten and not below it", async () => {
    const ten = Array.from({ length: 10 }, (_, i) => 1000000000 + i);
    installSearch(
      found({
        results: ten.map(peerChannel),
        chats: ten.map((bare) => ({
          className: "Channel",
          id: BigInt(bare),
          title: `C${bare}`,
        })),
      }),
    );
    expect((await searchChannels({ query: "x" })).truncated).toBe(true);

    // withTelegram caches the connected client at module scope, so a second
    // installSearch needs a reset to take effect — see the identical pattern
    // in tests/telegram-search.test.ts's cursor-resume test.
    __resetClientForTests();
    const nine = ten.slice(0, 9);
    installSearch(
      found({
        results: nine.map(peerChannel),
        chats: nine.map((bare) => ({
          className: "Channel",
          id: BigInt(bare),
          title: `C${bare}`,
        })),
      }),
    );
    expect((await searchChannels({ query: "x" })).truncated).toBe(false);
  });

  it("cuts to limit before enriching, not after", async () => {
    const ten = Array.from({ length: 10 }, (_, i) => 1000000000 + i);
    const sent = installSearch(
      found({
        results: ten.map(peerChannel),
        chats: ten.map((bare) => ({
          className: "Channel",
          id: BigInt(bare),
          title: `C${bare}`,
        })),
      }),
    );
    const { candidates, truncated } = await searchChannels({
      query: "x",
      limit: 2,
    });
    expect(candidates).toHaveLength(2);
    expect(truncated).toBe(true);
    expect(sent.filter(isEnrichment)).toHaveLength(2);
  });

  it("reports truncated when limit cuts a page Telegram did not fill", async () => {
    const five = Array.from({ length: 5 }, (_, i) => 1000000000 + i);
    installSearch(
      found({
        results: five.map(peerChannel),
        chats: five.map((bare) => ({
          className: "Channel",
          id: BigInt(bare),
          title: `C${bare}`,
        })),
      }),
    );
    const { candidates, truncated } = await searchChannels({
      query: "x",
      limit: 2,
    });
    expect(candidates).toHaveLength(2);
    expect(truncated).toBe(true);
  });

  it("returns an empty list as a success", async () => {
    installSearch(found({}));
    await expect(searchChannels({ query: "nothing" })).resolves.toEqual({
      candidates: [],
      truncated: false,
    });
  });
});

import { getSimilarChannels } from "@/telegram/discovery";
import { __resetPeerCacheForTests } from "@/telegram/peer-resolve";

afterEach(() => {
  __resetPeerCacheForTests();
});

function chatsReply(count: number | undefined, ids: number[]) {
  return {
    className: count === undefined ? "messages.Chats" : "messages.ChatsSlice",
    ...(count === undefined ? {} : { count }),
    chats: ids.map((bare) => ({
      className: "Channel",
      id: BigInt(bare),
      title: `C${bare}`,
      participantsCount: bare,
    })),
  };
}

describe("getSimilarChannels", () => {
  it("omits the channel argument entirely when no source is given", async () => {
    const sent = installSearch(chatsReply(undefined, [1000000001]));
    await getSimilarChannels({});
    const recommendation = sent.find(
      (r) => requestName(r) === "channels.GetChannelRecommendations",
    );
    expect(recommendation).toBeDefined();
    expect((recommendation as { channel?: unknown }).channel).toBeUndefined();
  });

  it("passes a resolved handle when a source is given", async () => {
    const sent = installSearch(chatsReply(79, [1000000001]));
    await getSimilarChannels({ source: "@alpha" });
    const recommendation = sent.find(
      (r) => requestName(r) === "channels.GetChannelRecommendations",
    );
    expect(recommendation).toMatchObject({ channel: "alpha" });
  });

  it("reports total_similar in seeded mode and omits it in global mode", async () => {
    installSearch(chatsReply(79, [1000000001]));
    const seeded = await getSimilarChannels({ source: "@alpha" });
    expect(seeded.total_similar).toBe(79);
    expect(seeded.truncated).toBe(true);

    // withTelegram caches the connected client at module scope, so a second
    // installSearch needs a reset to take effect — see the identical pattern
    // in the searchChannels truncation test above.
    __resetClientForTests();
    installSearch(chatsReply(undefined, [1000000001]));
    const global = await getSimilarChannels({});
    expect(global.total_similar).toBeUndefined();
    expect(global.truncated).toBe(false);
  });

  it("never re-sorts Telegram's order", async () => {
    // Ascending subscriber counts: a tool that ranked by popularity would
    // reverse these, and README §D forbids the server ranking candidates.
    installSearch(chatsReply(undefined, [10, 20, 30]));
    const { candidates } = await getSimilarChannels({});
    expect(candidates.map((c) => c.subscriber_count)).toEqual([10, 20, 30]);
  });

  it("cuts a hundred global recommendations to the flood ceiling", async () => {
    const ids = Array.from({ length: 100 }, (_, i) => 1000000000 + i);
    const sent = installSearch(chatsReply(undefined, ids));
    const { candidates, truncated } = await getSimilarChannels({});
    expect(candidates).toHaveLength(MAX_ENRICHED_CANDIDATES);
    expect(truncated).toBe(true);
    expect(sent.filter(isEnrichment)).toHaveLength(MAX_ENRICHED_CANDIDATES);
  });

  it("returns no recommendations as a success", async () => {
    installSearch(chatsReply(undefined, []));
    await expect(getSimilarChannels({})).resolves.toEqual({
      candidates: [],
      truncated: false,
    });
  });
});
