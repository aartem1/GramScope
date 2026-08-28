import { describe, expect, it } from "vitest";
import { toCandidate } from "@/telegram/discovery";
import type { DialogIndex } from "@/telegram/dialog-index";

const HELD = "-1001111111111";

function index(ids: string[] = []): DialogIndex {
  return {
    byId: new Map(
      ids.map((id) => [
        id,
        {
          source_id: id,
          title: "Held",
          unread_count: 0,
          read_inbox_max_id: 0,
          folder_ids: [],
        },
      ]),
    ),
    folders: [],
  };
}

function channel(over: Record<string, unknown> = {}) {
  return {
    className: "Channel",
    id: 1111111111n,
    title: "Alpha News",
    broadcast: true,
    participantsCount: 4874,
    ...over,
  };
}

describe("toCandidate", () => {
  it("reads a live handle out of usernames[] when username is null", () => {
    // Measured 2026-08-28: contacts.search returns username: null for
    // collectible handles and puts the live one in usernames[].
    const candidate = toCandidate(
      channel({
        username: null,
        usernames: [{ username: "alpha_news", active: true }],
      }),
      index(),
    );
    expect(candidate.username).toBe("alpha_news");
    expect(candidate.url).toBe("https://t.me/alpha_news");
  });

  it("reports joined from the dialog index, not from the left flag", () => {
    // A stale `left` is exactly the disagreement this pins: the index is the
    // same authority every other tool means by "this account holds it".
    const held = toCandidate(channel({ left: true }), index([HELD]));
    const stranger = toCandidate(channel({ left: false }), index([]));
    expect(held.joined).toBe(true);
    expect(stranger.joined).toBe(false);
  });

  it("states every trust flag as a boolean, never as an absent key", () => {
    const clean = toCandidate(channel(), index());
    expect(clean).toMatchObject({
      verified: false,
      scam: false,
      fake: false,
      restricted: false,
    });
    const bad = toCandidate(
      channel({ scam: true, fake: true, restricted: true, verified: true }),
      index(),
    );
    expect(bad).toMatchObject({
      verified: true,
      scam: true,
      fake: true,
      restricted: true,
    });
  });

  it("prefers a fetched description over the entity's own about", () => {
    const candidate = toCandidate(channel({ about: "stale" }), index(), {
      description: "fetched",
    });
    expect(candidate.description).toBe("fetched");
  });

  it("carries id, title, type and subscriber count", () => {
    expect(toCandidate(channel({ username: "alpha" }), index())).toMatchObject({
      id: HELD,
      title: "Alpha News",
      type: "channel",
      subscriber_count: 4874,
      username: "alpha",
    });
  });
});
