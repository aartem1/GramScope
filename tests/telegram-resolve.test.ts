import { afterEach, describe, expect, it } from "vitest";
import { resolveTelegramUrl } from "@/telegram/resolve";
import {
  __resetClientForTests,
  __setClientFactoryForTests,
} from "@/telegram/client";
import { __resetPeerCacheForTests } from "@/telegram/peer-resolve";

const HELD = "-1001111111111";

function install(options: {
  entity?: Record<string, unknown>;
  full?: unknown;
  invite?: unknown;
}) {
  const sent: string[] = [];
  __setClientFactoryForTests(async () => ({
    connected: true,
    connect: async () => true,
    getDialogs: async () => [
      {
        id: HELD,
        title: "Alpha",
        entity: { className: "Channel", id: 1111111111n, title: "Alpha" },
        dialog: { readInboxMaxId: 0 },
        unreadCount: 0,
        date: 1,
        message: { id: 1 },
      },
    ],
    getEntity: async () =>
      options.entity ?? {
        className: "Channel",
        id: 1111111111n,
        title: "Alpha",
      },
    getMessages: async () => [],
    invoke: async (request: unknown) => {
      const r = request as { className: string };
      sent.push(r.className);
      if (r.className === "messages.CheckChatInvite") return options.invite;
      if (r.className === "channels.GetFullChannel") return options.full;
      return {};
    },
  }));
  return sent;
}

afterEach(() => {
  __setClientFactoryForTests(undefined);
  __resetClientForTests();
  __resetPeerCacheForTests();
});

describe("resolveTelegramUrl", () => {
  it("resolves a channel the account already holds", async () => {
    const sent = install({
      full: {
        fullChat: {
          about: "a",
          linkedChatId: 2222222222n,
          participantsCount: 40,
        },
      },
    });
    const result = await resolveTelegramUrl({ url: "https://t.me/alpha" });

    expect(result.kind).toBe("source");
    expect(result.source).toMatchObject({
      source_id: HELD,
      title: "Alpha",
      type: "channel",
      joined: true,
      linked_discussion_id: "-1002222222222",
    });
    expect(sent.filter((c) => c === "channels.GetFullChannel")).toHaveLength(1);
  });

  it("marks a channel the account has not joined", async () => {
    install({
      entity: {
        className: "Channel",
        id: 999n,
        title: "Outside",
        username: "outside",
        participantsCount: 12345,
      },
      full: { fullChat: {} },
    });
    const result = await resolveTelegramUrl({ url: "t.me/outside" });
    expect(result.source).toMatchObject({
      source_id: "-100999",
      username: "outside",
      subscriber_count: 12345,
      joined: false,
    });
  });

  it("reads a post link, and a comment link under it", async () => {
    install({ full: { fullChat: {} } });
    const post = await resolveTelegramUrl({ url: "https://t.me/alpha/500" });
    expect(post.kind).toBe("post");
    expect(post.message_id).toBe(500);
    expect(post.comment_id).toBeUndefined();

    const comment = await resolveTelegramUrl({
      url: "https://t.me/alpha/500?comment=42",
    });
    expect(comment.kind).toBe("post");
    expect(comment.message_id).toBe(500);
    expect(comment.comment_id).toBe(42);
  });

  it("previews an invite without joining and without a peer id", async () => {
    const sent = install({
      invite: {
        className: "ChatInvite",
        title: "Private Room",
        participantsCount: 7,
        megagroup: true,
      },
    });
    const result = await resolveTelegramUrl({ url: "https://t.me/+AbCdEf" });

    expect(result.kind).toBe("invite");
    expect(result.source).toEqual({
      title: "Private Room",
      type: "group",
      subscriber_count: 7,
      joined: false,
    });
    // The fake records every invoke, and fetching the dialog index invokes
    // messages.GetDialogFilters first, so assert on what this tool sent.
    expect(sent).toContain("messages.CheckChatInvite");
    expect(sent).not.toContain("channels.GetFullChannel");
  });

  it("reports an invite the account already joined as joined", async () => {
    install({
      invite: {
        className: "ChatInviteAlready",
        chat: { className: "Channel", id: 1111111111n, title: "Alpha" },
      },
    });
    const result = await resolveTelegramUrl({ url: "t.me/joinchat/AbCdEf" });
    expect(result.kind).toBe("invite");
    expect(result.source).toMatchObject({
      source_id: HELD,
      title: "Alpha",
      joined: true,
    });
  });

  it("does not expose an unheld ChatInvitePeek peer id", async () => {
    install({
      invite: {
        className: "ChatInvitePeek",
        chat: {
          className: "Channel",
          id: 999n,
          title: "Private Preview",
          megagroup: true,
        },
      },
    });

    const result = await resolveTelegramUrl({ url: "t.me/+AbCdEf" });

    expect(result.source).toEqual({
      title: "Private Preview",
      type: "group",
      joined: false,
    });
  });

  it("keeps the peer id of a ChatInviteAlready the dialog index has not caught up with", async () => {
    // Pins the className check itself: withholding on `held` alone would also
    // strip the id here, where the account demonstrably holds the peer.
    install({
      invite: {
        className: "ChatInviteAlready",
        chat: { className: "Channel", id: 999n, title: "Joined Elsewhere" },
      },
    });

    const result = await resolveTelegramUrl({ url: "t.me/+AbCdEf" });

    expect(result.source).toMatchObject({
      source_id: "-100999",
      title: "Joined Elsewhere",
      joined: false,
    });
  });

  it("fails a private internal link the account cannot hold", async () => {
    __setClientFactoryForTests(async () => ({
      connected: true,
      connect: async () => true,
      getDialogs: async () => [],
      getEntity: async () => {
        throw Object.assign(new Error("x"), {
          errorMessage: "CHANNEL_INVALID",
        });
      },
      getMessages: async () => [],
      invoke: async () => ({}),
    }));
    await expect(
      resolveTelegramUrl({ url: "https://t.me/c/9999999999/12" }),
    ).rejects.toMatchObject({ code: "CHANNEL_NOT_FOUND" });
  });
});
