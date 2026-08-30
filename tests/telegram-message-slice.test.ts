import { describe, expect, it } from "vitest";
import { fetchSlice, type SliceRequest } from "@/telegram/message-slice";
import type { TelegramLike } from "@/telegram/client";

const SOURCE_ID = "-1001234567890";

/** Newest-first history, one message per hour ending 2025-01-01T00:00:00Z. */
function history(count: number, startId = 1000) {
  return Array.from({ length: count }, (_, i) => ({
    className: "Message",
    id: startId - i,
    date: 1735689600 - i * 3600,
    message: `post ${startId - i}`,
  }));
}

function client(
  messages: unknown[],
  seen?: (params: Record<string, unknown>) => void,
): TelegramLike {
  return {
    connected: true,
    connect: async () => true,
    invoke: async () => ({}),
    getDialogs: async () => [],
    getEntity: async () => ({}),
    getMessages: async (_entity, params) => {
      seen?.(params);
      const limit = typeof params.limit === "number" ? params.limit : 0;
      return messages.slice(0, limit);
    },
    iterDownload: async function* () {},
  };
}

const base: SliceRequest = { sourceId: SOURCE_ID, limit: 5, offsetId: 0 };

describe("fetchSlice", () => {
  it("returns mapped messages newest first", async () => {
    const slice = await fetchSlice(client(history(5)), base);
    expect(slice.messages.map((m) => m.id)).toEqual([
      1000, 999, 998, 997, 996,
    ]);
    expect(slice.messages[0]!.chat_id).toBe(SOURCE_ID);
  });

  it("reports exhaustion when Telegram returns fewer than the limit", async () => {
    const slice = await fetchSlice(client(history(3)), base);
    expect(slice.hasMore).toBe(false);
    expect(slice.nextOffsetId).toBe(0);
  });

  it("reports a resume point when the page is full", async () => {
    const slice = await fetchSlice(client(history(20)), base);
    expect(slice.hasMore).toBe(true);
    expect(slice.nextOffsetId).toBe(996);
  });

  it("stops at the lower date bound and calls the source exhausted", async () => {
    // from = 1735689600 - 2*3600, so ids 1000, 999, 998 are in range and 997
    // is the first one that predates it.
    const slice = await fetchSlice(client(history(20)), {
      ...base,
      fromSeconds: 1735689600 - 2 * 3600,
    });
    expect(slice.messages.map((m) => m.id)).toEqual([1000, 999, 998]);
    expect(slice.hasMore).toBe(false);
  });

  it("drops messages newer than the upper date bound", async () => {
    const slice = await fetchSlice(client(history(20)), {
      ...base,
      toSeconds: 1735689600 - 2 * 3600,
    });
    expect(slice.messages.map((m) => m.id)).toEqual([998, 997, 996]);
  });

  it("asks Telegram to skip past the upper bound on a first page", async () => {
    let params: Record<string, unknown> | undefined;
    await fetchSlice(
      client(history(5), (p) => {
        params = p;
      }),
      { ...base, toSeconds: 1735689600 },
    );
    // offset_date is "strictly before", so an inclusive `to` is to + 1.
    expect(params?.offsetDate).toBe(1735689601);
  });

  it("resumes from the cursor's offset instead of the date", async () => {
    let params: Record<string, unknown> | undefined;
    await fetchSlice(
      client(history(5), (p) => {
        params = p;
      }),
      { ...base, offsetId: 990, toSeconds: 1735689600 },
    );
    expect(params?.offsetId).toBe(990);
    expect(params?.offsetDate).toBeUndefined();
  });

  it("stops at the read pointer when unread_only is set", async () => {
    const slice = await fetchSlice(client(history(20)), {
      ...base,
      unreadOnly: true,
      readInboxMaxId: 997,
    });
    expect(slice.messages.map((m) => m.id)).toEqual([1000, 999, 998]);
    expect(slice.hasMore).toBe(false);
  });

  it("reads everything when unread_only is set but no pointer is known", async () => {
    const slice = await fetchSlice(client(history(3)), {
      ...base,
      unreadOnly: true,
    });
    expect(slice.messages).toHaveLength(3);
  });

  it("passes a TL filter for a typed media request", async () => {
    let params: Record<string, unknown> | undefined;
    await fetchSlice(
      client(history(3), (p) => {
        params = p;
      }),
      { ...base, mediaType: "photo" },
    );
    expect(
      (params?.filter as { className?: string } | undefined)?.className,
    ).toBe("InputMessagesFilterPhotos");
  });

  it("reads by handle instead of the marked id when one is given", async () => {
    let seenEntity: string | undefined;
    await fetchSlice(
      {
        connected: true,
        connect: async () => true,
        invoke: async () => ({}),
        getDialogs: async () => [],
        getEntity: async () => ({}),
        getMessages: async (entity, params) => {
          seenEntity = entity;
          const limit = typeof params.limit === "number" ? params.limit : 0;
          return history(5).slice(0, limit);
        },
        iterDownload: async function* () {},
      },
      { ...base, handle: "outside" },
    );
    expect(seenEntity).toBe("outside");
  });

  it("passes no filter for an untyped request", async () => {
    let params: Record<string, unknown> | undefined;
    await fetchSlice(
      client(history(3), (p) => {
        params = p;
      }),
      base,
    );
    expect(params?.filter).toBeUndefined();
  });

  it("skips service and empty messages", async () => {
    const slice = await fetchSlice(
      client([
        { className: "MessageService", id: 5, date: 1735689600 },
        { className: "MessageEmpty", id: 4, date: 1735689600 },
        { className: "Message", id: 3, date: 1735689600, message: "real" },
      ]),
      { ...base, limit: 3 },
    );
    expect(slice.messages.map((m) => m.id)).toEqual([3]);
  });
});
