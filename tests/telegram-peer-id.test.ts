import { describe, expect, it } from "vitest";
import {
  entityMarkedId,
  entityUsername,
  inputPeerMarkedId,
  markedChannelId,
  markedChatId,
  peerKind,
  readBigId,
  sourceType,
} from "@/peer-id";

describe("readBigId", () => {
  it("unwraps every shape teleproto uses for an id", () => {
    expect(readBigId(42n)).toBe("42");
    expect(readBigId(42)).toBe("42");
    expect(readBigId("42")).toBe("42");
    expect(readBigId({ value: 42n })).toBe("42");
    expect(readBigId(undefined)).toBeUndefined();
  });

  it.each([
    ["an empty string", ""],
    ["a non-decimal string", "12x"],
    ["a whitespace-padded string", " 42"],
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
    ["a fractional number", 42.5],
    ["an unsafe integer", Number.MAX_SAFE_INTEGER + 1],
  ])("rejects %s directly and inside a BigInteger-like wrapper", (_name, value) => {
    expect(readBigId(value)).toBeUndefined();
    expect(readBigId({ value })).toBeUndefined();
  });
});

describe("marking", () => {
  it("prefixes a channel id with -100", () => {
    expect(markedChannelId("1234567890")).toBe("-1001234567890");
  });

  it("negates a legacy chat id", () => {
    expect(markedChatId("987654321")).toBe("-987654321");
  });
});

describe("inputPeerMarkedId", () => {
  it("marks each InputPeer variant the way teleproto's getPeerId does", () => {
    expect(inputPeerMarkedId({ channelId: { value: 1n } })).toBe("-1001");
    expect(inputPeerMarkedId({ chatId: { value: 2n } })).toBe("-2");
    expect(inputPeerMarkedId({ userId: { value: 3n } })).toBe("3");
    expect(inputPeerMarkedId({})).toBeUndefined();
    expect(inputPeerMarkedId(null)).toBeUndefined();
  });
});

describe("entityMarkedId", () => {
  it("marks a resolved entity by its className", () => {
    expect(entityMarkedId({ className: "Channel", id: { value: 1n } })).toBe(
      "-1001",
    );
    expect(entityMarkedId({ className: "Chat", id: { value: 2n } })).toBe("-2");
    expect(entityMarkedId({ className: "User", id: { value: 3n } })).toBe("3");
  });

  it("agrees with the InputPeer form for the same peer", () => {
    expect(entityMarkedId({ className: "Channel", id: { value: 1234567890n } })).toBe(
      inputPeerMarkedId({ channelId: { value: 1234567890n } }),
    );
  });

  it("returns undefined when there is no id to mark", () => {
    expect(entityMarkedId({ className: "Channel" })).toBeUndefined();
  });
});

describe("entityUsername", () => {
  it("reads the legacy singular field", () => {
    expect(entityUsername({ className: "Channel", username: "ainews" })).toBe(
      "ainews",
    );
  });

  it("reads the multi-username list when the singular field is null", () => {
    // @exampleuser's real shape: the collectible/Fragment feature moves every handle
    // into `usernames` and leaves `username` null.
    expect(
      entityUsername({
        className: "Channel",
        username: null,
        usernames: [
          { className: "Username", username: "exampleuser", editable: true, active: true },
          { className: "Username", username: "pavel", active: true },
        ],
      }),
    ).toBe("exampleuser");
  });

  it("prefers the singular field when an entity carries both", () => {
    expect(
      entityUsername({
        className: "Channel",
        username: "primary",
        usernames: [
          { className: "Username", username: "collectible", editable: true, active: true },
        ],
      }),
    ).toBe("primary");
  });

  it("prefers the editable username over an earlier active one", () => {
    expect(
      entityUsername({
        username: null,
        usernames: [
          { username: "first", active: true },
          { username: "own", editable: true, active: true },
        ],
      }),
    ).toBe("own");
  });

  it("falls back to the first active username when none is editable", () => {
    expect(
      entityUsername({
        usernames: [
          { username: "first", active: true },
          { username: "second", active: true },
        ],
      }),
    ).toBe("first");
  });

  it("never returns an inactive username, which no longer resolves", () => {
    expect(
      entityUsername({
        usernames: [{ username: "retired" }, { username: "sold", active: false }],
      }),
    ).toBeUndefined();
  });

  it("returns undefined for a peer with no public handle at all", () => {
    expect(entityUsername({ className: "Channel", id: 1n })).toBeUndefined();
    expect(entityUsername({ username: "" })).toBeUndefined();
    expect(entityUsername({ usernames: "not a list" })).toBeUndefined();
    expect(entityUsername(null)).toBeUndefined();
  });
});

describe("sourceType", () => {
  it("classifies a broadcast channel", () => {
    expect(sourceType({ className: "Channel" })).toBe("channel");
  });

  it("classifies a megagroup as a group, not a channel", () => {
    expect(sourceType({ className: "Channel", megagroup: true })).toBe("group");
  });

  it("classifies a legacy chat as a group", () => {
    expect(sourceType({ className: "Chat" })).toBe("group");
  });

  it("classifies a user as a chat", () => {
    expect(sourceType({ className: "User" })).toBe("chat");
  });

  it("falls back to chat for anything unrecognized", () => {
    expect(sourceType({})).toBe("chat");
    expect(sourceType(undefined)).toBe("chat");
  });
});

describe("peerKind", () => {
  it("separates a channel, a legacy chat and a user", () => {
    // sourceType cannot serve here: it maps Chat to "group" and falls back to
    // "chat" for a user, so it cannot tell a legacy chat from a user — which
    // is exactly the distinction InputPeer construction turns on.
    expect(peerKind({ className: "Channel", id: { value: 1n } })).toBe(
      "channel",
    );
    expect(peerKind({ className: "Chat", id: { value: 1n } })).toBe("chat");
    expect(peerKind({ className: "User", id: { value: 1n } })).toBe("user");
    expect(peerKind(undefined)).toBe("user");
  });
});
