import { describe, expect, it } from "vitest";
import {
  entityMarkedId,
  inputPeerMarkedId,
  markedChannelId,
  markedChatId,
  readBigId,
  sourceType,
} from "@/telegram/peer-id";

describe("readBigId", () => {
  it("unwraps every shape teleproto uses for an id", () => {
    expect(readBigId(42n)).toBe("42");
    expect(readBigId(42)).toBe("42");
    expect(readBigId("42")).toBe("42");
    expect(readBigId({ value: 42n })).toBe("42");
    expect(readBigId(undefined)).toBeUndefined();
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
