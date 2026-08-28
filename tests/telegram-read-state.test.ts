import { afterEach, describe, expect, it } from "vitest";
import { markRead, markUnread } from "@/telegram/read-state";
import {
  __resetClientForTests,
  __setClientFactoryForTests,
} from "@/telegram/client";

const CHANNEL = "-100111";
const CHAT = "-222";
const USER = "333";

const dialogs = [
  {
    id: { value: -100111n },
    title: "Alpha",
    unreadCount: 4,
    entity: { className: "Channel", id: { value: 111n } },
    dialog: { readInboxMaxId: 96 },
    message: { id: 100, date: 1735689600 },
  },
  {
    id: { value: -222n },
    title: "Legacy",
    unreadCount: 1,
    entity: { className: "Chat", id: { value: 222n } },
    dialog: { readInboxMaxId: 9 },
    message: { id: 10, date: 1735689600 },
  },
];

function factory(options: {
  sent: unknown[];
  entities?: Record<string, Record<string, unknown>>;
  failOn?: string;
}) {
  return async () => ({
    connected: true,
    connect: async () => true,
    invoke: async (request: unknown) => {
      options.sent.push(request);
      return true;
    },
    getDialogs: async () => dialogs,
    getEntity: async (id: string) => {
      if (id === options.failOn) {
        throw Object.assign(new Error("private"), {
          errorMessage: "CHANNEL_PRIVATE",
        });
      }
      return (
        options.entities?.[id] ?? { className: "Channel", id: { value: 111n } }
      );
    },
    getMessages: async () => [],
  });
}

afterEach(() => {
  __setClientFactoryForTests(undefined);
  __resetClientForTests();
});

describe("markRead", () => {
  it("advances a channel to an explicit message id", async () => {
    const sent: unknown[] = [];
    __setClientFactoryForTests(factory({ sent }));
    const result = await markRead({
      source_ids: [CHANNEL],
      up_to_message_id: 98,
    });
    expect(result.results).toEqual([
      { source_id: CHANNEL, read_inbox_max_id: 98 },
    ]);
    expect(result.failures).toEqual([]);
    expect((sent.at(-1) as { className?: string }).className).toBe(
      "channels.ReadHistory",
    );
    expect((sent.at(-1) as { maxId?: number }).maxId).toBe(98);
  });

  it("defaults to the source's latest message", async () => {
    const sent: unknown[] = [];
    __setClientFactoryForTests(factory({ sent }));
    const result = await markRead({ source_ids: [CHANNEL] });
    expect(result.results[0]!.read_inbox_max_id).toBe(100);
  });

  it("uses messages.readHistory for a legacy chat", async () => {
    const sent: unknown[] = [];
    __setClientFactoryForTests(
      factory({
        sent,
        entities: { [CHAT]: { className: "Chat", id: { value: 222n } } },
      }),
    );
    await markRead({ source_ids: [CHAT] });
    expect((sent.at(-1) as { className?: string }).className).toBe(
      "messages.ReadHistory",
    );
  });

  it("reports a per-source failure without failing the call", async () => {
    const sent: unknown[] = [];
    __setClientFactoryForTests(factory({ sent, failOn: CHANNEL }));
    const result = await markRead({ source_ids: [CHANNEL, CHAT] });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      source_id: CHANNEL,
      code: "PRIVATE_CHANNEL_NOT_ACCESSIBLE",
    });
    expect(result.results).toHaveLength(1);
  });

  it("always returns both arrays", async () => {
    __setClientFactoryForTests(factory({ sent: [] }));
    const result = await markRead({ source_ids: [CHANNEL] });
    expect(Array.isArray(result.results)).toBe(true);
    expect(Array.isArray(result.failures)).toBe(true);
  });

  it("rejects an empty or oversized selection", async () => {
    __setClientFactoryForTests(factory({ sent: [] }));
    await expect(markRead({ source_ids: [] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(
      markRead({
        source_ids: Array.from({ length: 26 }, (_, i) => `-100${i}`),
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("markUnread", () => {
  it("sets the flag through messages.MarkDialogUnread", async () => {
    const sent: unknown[] = [];
    __setClientFactoryForTests(factory({ sent }));
    const result = await markUnread({ source_ids: [CHANNEL], unread: true });

    expect(result.results).toEqual([{ source_id: CHANNEL, unread_mark: true }]);
    expect(result.failures).toEqual([]);

    const request = sent.at(-1) as {
      className?: string;
      unread?: boolean;
      peer?: { className?: string; peer?: { className?: string } };
    };
    expect(request.className).toBe("messages.MarkDialogUnread");
    expect(request.unread).toBe(true);
    expect(request.peer?.className).toBe("InputDialogPeer");
    expect(request.peer?.peer?.className).toBe("InputPeerChannel");
  });

  it("clears the flag when unread is false", async () => {
    const sent: unknown[] = [];
    __setClientFactoryForTests(factory({ sent }));
    const result = await markUnread({ source_ids: [CHANNEL], unread: false });
    expect((sent.at(-1) as { unread?: boolean }).unread).toBe(false);
    expect(result.results[0]!.unread_mark).toBe(false);
  });

  it("reports a per-source failure without failing the call", async () => {
    const sent: unknown[] = [];
    __setClientFactoryForTests(
      factory({
        sent,
        failOn: CHANNEL,
        entities: { [CHAT]: { className: "Chat", id: { value: 222n } } },
      }),
    );
    const result = await markUnread({
      source_ids: [CHANNEL, CHAT],
      unread: true,
    });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      source_id: CHANNEL,
      code: "PRIVATE_CHANNEL_NOT_ACCESSIBLE",
    });
    expect(result.results).toHaveLength(1);
  });

  it("builds an InputPeerChat for a legacy chat, not an InputPeerChannel", async () => {
    const sent: unknown[] = [];
    __setClientFactoryForTests(
      factory({
        sent,
        entities: { [CHAT]: { className: "Chat", id: { value: 222n } } },
      }),
    );
    await markUnread({ source_ids: [CHAT], unread: true });

    const request = sent.at(-1) as {
      peer?: { peer?: { className?: string; chatId?: unknown } };
    };
    expect(request.peer?.peer?.className).toBe("InputPeerChat");
    expect(request.peer?.peer?.chatId).toEqual({ value: 222n });
  });

  it("builds an InputPeerUser for a user, not an InputPeerChat", async () => {
    const sent: unknown[] = [];
    __setClientFactoryForTests(
      factory({
        sent,
        entities: { [USER]: { className: "User", id: { value: 333n } } },
      }),
    );
    await markUnread({ source_ids: [USER], unread: true });

    const request = sent.at(-1) as {
      peer?: { peer?: { className?: string; userId?: unknown } };
    };
    expect(request.peer?.peer?.className).toBe("InputPeerUser");
    expect(request.peer?.peer?.userId).toEqual({ value: 333n });
  });

  it("rejects an empty or oversized selection", async () => {
    __setClientFactoryForTests(factory({ sent: [] }));
    await expect(
      markUnread({ source_ids: [], unread: true }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      markUnread({
        source_ids: Array.from({ length: 26 }, (_, i) => `-100${i}`),
        unread: true,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
