import { afterEach, describe, expect, it } from "vitest";
import {
  nameKey,
  parseTelegramName,
  resolveSource,
  resolvesLocally,
  __resetPeerCacheForTests,
} from "@/telegram/peer-resolve";
import type { TelegramLike } from "@/telegram/client";
import { GramScopeError } from "@/errors/taxonomy";

const HELD = "-1001111111111";

function entry(id: string, title: string, username?: string) {
  return {
    source_id: id,
    title,
    ...(username !== undefined ? { username } : {}),
    unread_count: 0,
    read_inbox_max_id: 0,
    folder_ids: [] as string[],
  };
}

const index = {
  byId: new Map([[HELD, entry(HELD, "Held Channel", "held")]]),
  folders: [],
};

function client(entities: Record<string, Record<string, unknown>>) {
  const calls: string[] = [];
  const fake = {
    calls,
    connect: async () => true,
    invoke: async () => ({}),
    getDialogs: async () => [],
    getMessages: async () => [],
    getEntity: async (target: string) => {
      calls.push(target);
      const found = entities[target];
      if (!found) throw new Error("CHANNEL_INVALID");
      return found;
    },
  };
  return fake as unknown as TelegramLike & { calls: string[] };
}

afterEach(() => __resetPeerCacheForTests());

describe("parseTelegramName", () => {
  it("reads every form of a source name", () => {
    expect(parseTelegramName("-1001234567890")).toEqual({
      kind: "internal",
      markedId: "-1001234567890",
    });
    expect(parseTelegramName("@exampleuser")).toEqual({
      kind: "username",
      username: "exampleuser",
    });
    expect(parseTelegramName("exampleuser")).toEqual({
      kind: "username",
      username: "exampleuser",
    });
    expect(parseTelegramName("https://t.me/exampleuser")).toEqual({
      kind: "username",
      username: "exampleuser",
    });
    expect(parseTelegramName("t.me/s/exampleuser")).toEqual({
      kind: "username",
      username: "exampleuser",
    });
    expect(parseTelegramName("https://t.me/exampleuser/123")).toEqual({
      kind: "username",
      username: "exampleuser",
      messageId: 123,
    });
    expect(parseTelegramName("https://t.me/exampleuser/123?comment=456")).toEqual({
      kind: "username",
      username: "exampleuser",
      messageId: 123,
      commentId: 456,
    });
    expect(parseTelegramName("https://t.me/c/1234567890/55")).toEqual({
      kind: "internal",
      markedId: "-1001234567890",
      messageId: 55,
    });
    expect(parseTelegramName("https://t.me/+AbCdEf")).toEqual({
      kind: "invite",
      hash: "AbCdEf",
    });
    expect(parseTelegramName("https://t.me/joinchat/AbCdEf")).toEqual({
      kind: "invite",
      hash: "AbCdEf",
    });
  });

  it("rejects what is not a source name", () => {
    for (const bad of ["", "   ", "https://example.com/exampleuser", "a b c"]) {
      expect(() => parseTelegramName(bad), bad).toThrow(GramScopeError);
    }
  });
});

describe("resolveSource", () => {
  it("answers from the dialog index without a round trip", async () => {
    const fake = client({});
    const resolved = await resolveSource(fake, index, HELD);
    expect(resolved).toEqual({
      source_id: HELD,
      title: "Held Channel",
      username: "held",
      handle: "held",
    });
    expect(fake.calls).toEqual([]);
  });

  it("matches an index entry by its username too", async () => {
    const fake = client({});
    expect((await resolveSource(fake, index, "@Held")).source_id).toBe(HELD);
    expect(fake.calls).toEqual([]);
  });

  it("resolves an outside channel by username and keeps it as the handle", async () => {
    const fake = client({
      outside: {
        className: "Channel",
        id: 999n,
        title: "Outside",
        username: "outside",
      },
    });
    const resolved = await resolveSource(fake, index, "https://t.me/outside");
    expect(resolved).toEqual({
      source_id: "-100999",
      title: "Outside",
      username: "outside",
      handle: "outside",
      entity: {
        className: "Channel",
        id: 999n,
        title: "Outside",
        username: "outside",
      },
    });
    expect(fake.calls).toEqual(["outside"]);
  });

  it("keeps travelling by username when only the multi-username list carries it", async () => {
    // The real @exampleuser shape. Reading only the singular field left `handle` as
    // the bare marked id, which no cold instance can resolve.
    const fake = client({
      outside: {
        className: "Channel",
        id: 999n,
        title: "Outside",
        username: null,
        usernames: [
          {
            className: "Username",
            username: "outside",
            editable: true,
            active: true,
          },
          { className: "Username", username: "outside_old", active: true },
        ],
      },
    });
    const resolved = await resolveSource(fake, index, "https://t.me/outside");
    expect(resolved.source_id).toBe("-100999");
    expect(resolved.username).toBe("outside");
    expect(resolved.handle).toBe("outside");
  });

  it("still falls back to the marked id when a peer has no public handle", async () => {
    const fake = client({
      "-100999": { className: "Channel", id: 999n, title: "Private" },
    });
    const resolved = await resolveSource(fake, index, "-100999");
    expect(resolved.username).toBeUndefined();
    expect(resolved.handle).toBe("-100999");
  });

  it("memoizes a resolution for the life of the instance", async () => {
    const fake = client({
      outside: {
        className: "Channel",
        id: 999n,
        title: "Outside",
        username: "outside",
      },
    });
    await resolveSource(fake, index, "@outside");
    await resolveSource(fake, index, "https://t.me/outside/17");
    expect(fake.calls).toEqual(["outside"]);
  });

  it("refuses an invite link as a source name", async () => {
    const fake = client({});
    await expect(resolveSource(fake, index, "t.me/+AbCdEf")).rejects.toThrow(
      /resolve_telegram_url/,
    );
  });
});

describe("nameKey", () => {
  it("gives every spelling of one peer the same key", () => {
    expect(nameKey("@Alpha")).toBe("u:alpha");
    expect(nameKey("alpha")).toBe("u:alpha");
    expect(nameKey("https://t.me/alpha")).toBe("u:alpha");
    expect(nameKey("t.me/s/alpha/42")).toBe("u:alpha");
    expect(nameKey("-1001111111111")).toBe("i:-1001111111111");
    expect(nameKey("t.me/c/1111111111/42")).toBe("i:-1001111111111");
    expect(nameKey("t.me/+AbCdEf")).toBe("v:AbCdEf");
  });

  it("keeps distinct peers apart across key kinds", () => {
    expect(nameKey("@alpha")).not.toBe(nameKey("@beta"));
    expect(nameKey("-1001111111111")).not.toBe(nameKey("-1002222222222"));
    expect(nameKey("@alpha")).not.toBe(nameKey("-1001111111111"));
  });

  it("falls back to the raw text for a name that does not parse", () => {
    // Such a name can only ever become an error row, and two identical bad
    // names are still one row. The prefix keeps it out of the other kinds.
    expect(nameKey("  Alpha News  ")).toBe("raw:alpha news");
    expect(nameKey("Alpha News")).toBe(nameKey("alpha news"));
    expect(nameKey("")).toBe("raw:");
    expect(nameKey("Alpha News").startsWith("raw:")).toBe(true);
  });
});

describe("resolvesLocally", () => {
  it("is true only for a peer the dialog index already holds", () => {
    expect(resolvesLocally(index, HELD)).toBe(true);
    expect(resolvesLocally(index, "@held")).toBe(true);
    expect(resolvesLocally(index, "https://t.me/HELD")).toBe(true);
    expect(resolvesLocally(index, "-1009999999999")).toBe(false);
    expect(resolvesLocally(index, "@outside")).toBe(false);
  });

  it("counts an unusable name as needing the network", () => {
    // It fails in resolveSource, not in the budget, so it must not be free.
    expect(resolvesLocally(index, "Alpha News")).toBe(false);
    expect(resolvesLocally(index, "t.me/+AbCdEf")).toBe(false);
  });
});
