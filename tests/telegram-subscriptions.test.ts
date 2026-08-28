import { afterEach, describe, expect, it } from "vitest";
import { joinChannel } from "@/telegram/subscriptions";
import {
  __resetClientForTests,
  __setClientFactoryForTests,
} from "@/telegram/client";
import { __resetPeerCacheForTests } from "@/telegram/peer-resolve";

const HELD = "-100111";

const heldDialogs = [
  {
    id: { value: -100111n },
    title: "Alpha",
    unreadCount: 0,
    entity: {
      className: "Channel",
      id: { value: 111n },
      username: "alpha",
      accessHash: { value: 5n },
    },
    dialog: { readInboxMaxId: 96 },
    message: { id: 100, date: 1735689600 },
  },
];

function factory(options: {
  sent: unknown[];
  entity?: Record<string, unknown>;
  failOn?: string;
}) {
  return async () => ({
    connected: true,
    connect: async () => true,
    invoke: async (request: unknown) => {
      options.sent.push(request);
      const className = (request as { className?: string }).className;
      if (className === "messages.GetDialogFilters") return { filters: [] };
      return { className: "Updates" };
    },
    getDialogs: async () => heldDialogs,
    getEntity: async (name: string) => {
      if (name === options.failOn) {
        throw Object.assign(new Error("private"), {
          errorMessage: "CHANNEL_PRIVATE",
        });
      }
      return (
        options.entity ?? {
          className: "Channel",
          id: { value: 999n },
          title: "Beta",
          username: "beta",
          accessHash: { value: 7n },
        }
      );
    },
    getMessages: async () => [],
  });
}

afterEach(() => {
  __setClientFactoryForTests(undefined);
  __resetClientForTests();
  __resetPeerCacheForTests();
});

describe("joinChannel", () => {
  it("joins a public channel the account does not follow", async () => {
    const sent: unknown[] = [];
    __setClientFactoryForTests(factory({ sent }));
    const result = await joinChannel({ source: "@beta" });

    expect(result.already_member).toBe(false);
    // Spec §4.2: the response names the object that was actually changed.
    expect(result.source).toMatchObject({
      id: "-100999",
      title: "Beta",
      username: "beta",
    });
    expect(
      sent.some(
        (r) =>
          (r as { className?: string }).className === "channels.JoinChannel",
      ),
    ).toBe(true);
  });

  it("treats an existing membership as a success and sends no join", async () => {
    const sent: unknown[] = [];
    __setClientFactoryForTests(factory({ sent }));
    const result = await joinChannel({ source: "@alpha" });

    expect(result.already_member).toBe(true);
    expect(result.source.id).toBe(HELD);
    expect(
      sent.some(
        (r) =>
          (r as { className?: string }).className === "channels.JoinChannel",
      ),
    ).toBe(false);
  });

  it("maps a private channel to PRIVATE_CHANNEL_NOT_ACCESSIBLE", async () => {
    __setClientFactoryForTests(factory({ sent: [], failOn: "secret" }));
    await expect(joinChannel({ source: "@secret" })).rejects.toMatchObject({
      code: "PRIVATE_CHANNEL_NOT_ACCESSIBLE",
    });
  });

  it("refuses an invite link with a message naming the alternative", async () => {
    __setClientFactoryForTests(factory({ sent: [] }));
    await expect(
      joinChannel({ source: "https://t.me/+abcdef" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
