import { describe, expect, it } from "vitest";
import { readMessagesPage } from "@/telegram/tl-messages";

const chat = { className: "Channel", id: 111n, title: "Alpha" };

describe("readMessagesPage", () => {
  it("reads a slice with a total and a resume rate", () => {
    const page = readMessagesPage({
      className: "messages.MessagesSlice",
      count: 4820,
      nextRate: 1755000000,
      messages: [{ id: 7 }],
      chats: [chat],
      users: [],
    });
    expect(page.count).toBe(4820);
    expect(page.nextRate).toBe(1755000000);
    expect(page.messages).toEqual([{ id: 7 }]);
    expect(page.titles.get("-100111")).toBe("Alpha");
  });

  it("reads a bounded result, which carries no total", () => {
    const page = readMessagesPage({
      className: "messages.Messages",
      messages: [{ id: 7 }, { id: 6 }],
      chats: [],
      users: [],
    });
    expect(page.count).toBeUndefined();
    expect(page.nextRate).toBeUndefined();
    expect(page.messages).toHaveLength(2);
  });

  it("reads channel messages, which have a total but no rate", () => {
    const page = readMessagesPage({
      className: "messages.ChannelMessages",
      pts: 1,
      count: 217,
      messages: [{ id: 9 }],
      chats: [chat],
      users: [],
    });
    expect(page.count).toBe(217);
    expect(page.nextRate).toBeUndefined();
  });

  it("returns an empty page for anything else rather than throwing", () => {
    for (const raw of [
      undefined,
      null,
      {},
      {
        className: "messages.MessagesNotModified",
        count: 1,
        messages: [{ id: 1 }],
        chats: [chat],
      },
    ]) {
      const page = readMessagesPage(raw);
      expect(page.messages).toEqual([]);
      expect(page.count).toBeUndefined();
      expect(page.titles).toEqual(new Map());
    }
  });

  it("hands back a plain array, not a teleproto TotalList", () => {
    class TotalList extends Array {}
    const messages = TotalList.from([{ id: 1 }]) as unknown[];
    const page = readMessagesPage({
      className: "messages.Messages",
      messages,
      chats: [],
      users: [],
    });
    expect(Object.getPrototypeOf(page.messages)).toBe(Array.prototype);
  });
});
