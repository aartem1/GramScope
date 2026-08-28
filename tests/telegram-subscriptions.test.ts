import { afterEach, describe, expect, it } from "vitest";
import { joinChannel, leaveChannel } from "@/telegram/subscriptions";
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
  // A held private one-to-one chat, addressed only by its bare marked id
  // (no username): the regression case for the already-member kind guard.
  {
    id: { value: 555n },
    title: "Dana",
    unreadCount: 0,
    entity: {
      className: "User",
      id: { value: 555n },
      firstName: "Dana",
    },
    dialog: {},
    message: {},
  },
];

function factory(options: {
  sent: unknown[];
  entity?: Record<string, unknown>;
  entities?: Record<string, Record<string, unknown>>;
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
      if (options.entities?.[name]) return options.entities[name]!;
      if (options.entity) return options.entity;
      if (name === "alpha") {
        return {
          className: "Channel",
          id: { value: 111n },
          title: "Alpha",
          username: "alpha",
          accessHash: { value: 5n },
        };
      }
      return {
        className: "Channel",
        id: { value: 999n },
        title: "Beta",
        username: "beta",
        accessHash: { value: 7n },
      };
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

  it("rejects a held non-channel peer instead of reporting already_member", async () => {
    // Regression: a bare numeric id resolves for any chat the account
    // already belongs to, DMs included. The kind guard must fire before the
    // membership branch can short-circuit into a success for one.
    const sent: unknown[] = [];
    __setClientFactoryForTests(
      factory({
        sent,
        entities: {
          "555": {
            className: "User",
            id: { value: 555n },
            firstName: "Dana",
          },
        },
      }),
    );
    await expect(joinChannel({ source: "555" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
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

describe("leaveChannel", () => {
  it("leaves a channel the account follows and echoes it as it was", async () => {
    const sent: unknown[] = [];
    __setClientFactoryForTests(factory({ sent }));
    const result = await leaveChannel({ source: "@alpha" });

    expect(result.was_member).toBe(true);
    expect(result.source).toMatchObject({ id: HELD, username: "alpha" });
    expect(
      sent.some(
        (r) =>
          (r as { className?: string }).className === "channels.LeaveChannel",
      ),
    ).toBe(true);
  });

  it("is a success with was_member false when the account is not a member", async () => {
    const sent: unknown[] = [];
    __setClientFactoryForTests(factory({ sent }));
    const result = await leaveChannel({ source: "@beta" });

    expect(result.was_member).toBe(false);
    expect(
      sent.some(
        (r) =>
          (r as { className?: string }).className === "channels.LeaveChannel",
      ),
    ).toBe(false);
  });

  it("refuses a legacy chat rather than guessing at a different TL call", async () => {
    // channels.LeaveChannel takes an InputChannel. Leaving a legacy chat is
    // messages.DeleteChatUser and leaving a user dialog is a delete: different
    // calls with different consequences, none of them in this sub-project.
    const sent: unknown[] = [];
    __setClientFactoryForTests(
      factory({
        sent,
        entity: { className: "Chat", id: { value: 222n }, title: "Legacy" },
      }),
    );
    await expect(leaveChannel({ source: "-222" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });
});
