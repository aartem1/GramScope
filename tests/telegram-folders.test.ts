import { describe, expect, it } from "vitest";
import { mapDialogFilters, peerId } from "@/telegram/folders";

// Shapes mirror teleproto 1.229.0: messages.DialogFilters wraps `.filters`,
// `title` is TextWithEntities, and DialogFilterDefault carries no id/title.
// The ids inside an InputPeer are BARE; folders emit them MARKED, so that
// included_peer_ids is directly comparable to TelegramSource.id.
const raw = {
  className: "messages.DialogFilters",
  filters: [
    { className: "DialogFilterDefault" },
    {
      className: "DialogFilter",
      id: 2,
      title: { className: "TextWithEntities", text: "AI", entities: [] },
      includePeers: [
        { className: "InputPeerChannel", channelId: { value: 1234567890n } },
        { className: "InputPeerChat", chatId: { value: 987654321n } },
      ],
      excludePeers: [
        { className: "InputPeerUser", userId: { value: 555000111n } },
      ],
    },
    {
      className: "DialogFilterChatlist",
      id: 3,
      title: { className: "TextWithEntities", text: "Shared", entities: [] },
      includePeers: [
        { className: "InputPeerChannel", channelId: { value: 2233445566n } },
      ],
    },
  ],
};

describe("peerId", () => {
  it("marks a channel peer with -100", () => {
    expect(
      peerId({ className: "InputPeerChannel", channelId: { value: 1234567890n } }),
    ).toBe("-1001234567890");
  });

  it("marks a legacy chat peer by negation", () => {
    expect(
      peerId({ className: "InputPeerChat", chatId: { value: 987654321n } }),
    ).toBe("-987654321");
  });

  it("leaves a user peer unmarked", () => {
    expect(
      peerId({ className: "InputPeerUser", userId: { value: 555000111n } }),
    ).toBe("555000111");
  });

  it("returns undefined for an empty peer", () => {
    expect(peerId({ className: "InputPeerEmpty" })).toBeUndefined();
  });
});

describe("mapDialogFilters", () => {
  it("skips DialogFilterDefault, which has no id or title", () => {
    const folders = mapDialogFilters(raw);
    expect(folders.map((f) => f.id)).toEqual(["2", "3"]);
  });

  it("reads the title out of TextWithEntities", () => {
    expect(mapDialogFilters(raw)[0]!.title).toBe("AI");
  });

  it("maps both peer lists for a DialogFilter, marked", () => {
    const ai = mapDialogFilters(raw)[0]!;
    expect(ai.included_peer_ids).toEqual(["-1001234567890", "-987654321"]);
    expect(ai.excluded_peer_ids).toEqual(["555000111"]);
  });

  it("gives a chatlist folder an empty exclude list, since it has no excludePeers", () => {
    const shared = mapDialogFilters(raw)[1]!;
    expect(shared.included_peer_ids).toEqual(["-1002233445566"]);
    expect(shared.excluded_peer_ids).toEqual([]);
  });

  it("assigns order by position", () => {
    expect(mapDialogFilters(raw).map((f) => f.order)).toEqual([0, 1]);
  });

  it("returns an empty list when the wrapper has no filters", () => {
    expect(mapDialogFilters({ filters: [] })).toEqual([]);
  });
});
