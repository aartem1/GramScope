import { afterEach, describe, expect, it } from "vitest";
import { markRead } from "@/telegram/read-state";
import {
  __resetClientForTests,
  __setClientFactoryForTests,
} from "@/telegram/client";

const CHANNEL = "-100111";
const CHAT = "-222";

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
