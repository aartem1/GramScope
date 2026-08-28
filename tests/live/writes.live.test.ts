import { beforeAll, describe, expect, it } from "vitest";
import { joinChannel, leaveChannel } from "@/telegram/subscriptions";
import {
  addFolderSources,
  createFolder,
  deleteFolder,
  removeFolderSources,
  renameFolder,
} from "@/telegram/folder-edit";
import { markUnread } from "@/telegram/read-state";
import { fetchFolders } from "@/telegram/folders";
import { fetchDialogIndex } from "@/telegram/dialog-index";
import { getUnreadSummary } from "@/telegram/unread";
import { getChannel } from "@/telegram/dialogs";

const enabled = process.env.GRAMSCOPE_LIVE === "1";
const suite = enabled ? describe : describe.skip;

/**
 * A public channel this account does not follow, used as the join/leave
 * subject. Chosen because it is public, long-lived and unrelated to the
 * account's real interests, so joining and leaving it changes nothing the
 * owner cares about. Replace it if it ever goes private.
 */
const JOIN_TARGET = "@telegram";

// House rule, carried from discovery.live.test.ts: an assertion inside a loop
// over a fetched list proves nothing when the list is empty. Assert the length
// first.
suite("Writes against the real account", () => {
  beforeAll(() => {
    if (!process.env.TELEGRAM_SESSION) {
      throw new Error("TELEGRAM_SESSION is required for live tests");
    }
  });

  it("joins and leaves a public channel", async () => {
    const joined = await joinChannel({ source: JOIN_TARGET });
    expect(joined.source.id).toBeTruthy();

    try {
      const seen = await getChannel({ username: JOIN_TARGET.slice(1) });
      expect(seen.id).toBe(joined.source.id);

      const index = await fetchDialogIndex();
      expect(index.byId.has(joined.source.id)).toBe(true);
    } finally {
      // Only leave what this test joined. If the account already followed the
      // channel, leaving it would be an unrequested change to the workspace.
      if (!joined.already_member) {
        const left = await leaveChannel({ source: JOIN_TARGET });
        expect(left.was_member).toBe(true);
      }
    }

    if (!joined.already_member) {
      const after = await fetchDialogIndex();
      expect(after.byId.has(joined.source.id)).toBe(false);
    }
  });

  it("runs a folder through its whole lifecycle and leaves none behind", async () => {
    const before = await fetchFolders();
    const index = await fetchDialogIndex();
    const members = [...index.byId.keys()].slice(0, 3);
    expect(members.length, "the account holds fewer than three dialogs").toBe(
      3,
    );

    // Telegram caps a filter's title at 12 characters (measured live
    // 2026-08-29: 12 succeeds, 13 fails with MESSAGE_TOO_LONG on
    // messages.updateDialogFilter) — undocumented in teleproto's own types,
    // so these titles stay at or under that ceiling on purpose.
    //
    // The folder is created WITH members rather than empty-then-filled:
    // Telegram rejects an include-list of zero peers outright
    // (FILTER_INCLUDE_EMPTY), matching the official app, which will not save
    // a folder holding no chats either.
    const created = await createFolder({
      title: "GS live tmp",
      source_ids: [members[0]!, members[1]!],
    });
    try {
      expect(created.title).toBe("GS live tmp");
      expect(created.included_peer_ids).toEqual(
        expect.arrayContaining([members[0], members[1]]),
      );

      const filled = await addFolderSources({
        folder_id: created.id,
        source_ids: [members[2]!],
      });
      expect(filled.included_peer_ids).toEqual(expect.arrayContaining(members));

      const trimmed = await removeFolderSources({
        folder_id: created.id,
        source_ids: [members[0]!],
      });
      expect(trimmed.included_peer_ids).not.toContain(members[0]);
      expect(trimmed.included_peer_ids).toEqual(
        expect.arrayContaining([members[1], members[2]]),
      );

      const renamed = await renameFolder({
        folder_id: created.id,
        title: "GS live tm2",
      });
      expect(renamed.title).toBe("GS live tm2");

      const listed = await fetchFolders();
      expect(listed.find((f) => f.id === created.id)?.title).toBe(
        "GS live tm2",
      );
    } finally {
      await deleteFolder({ folder_id: created.id });
    }

    const after = await fetchFolders();
    expect(after.map((f) => f.id).sort()).toEqual(
      before.map((f) => f.id).sort(),
    );
  });

  it("edits a pre-existing folder without losing its unmodelled fields", async (ctx) => {
    // The §6 risk, live: emoticon, colour and pinned chats exist only in the
    // raw filter, and the fast tier proves the rule against a fake. This
    // proves the same filter survives a real round trip.
    const folders = await fetchFolders();
    const target = folders[0];
    // Skip visibly rather than pass silently: with no pre-existing folder
    // there is nothing to round-trip, and a green tick here would be mistaken
    // for evidence that the filter survives editing.
    if (!target) {
      ctx.skip();
      return;
    }

    const index = await fetchDialogIndex();
    const outsider = [...index.byId.keys()].find(
      (id) => !target.included_peer_ids.includes(id),
    );
    expect(
      outsider,
      "every dialog is already in the first folder",
    ).toBeTruthy();

    await addFolderSources({
      folder_id: target.id,
      source_ids: [outsider!],
    });
    try {
      const after = await fetchFolders();
      const edited = after.find((f) => f.id === target.id)!;
      expect(edited.title).toBe(target.title);
      expect(edited.included_peer_ids).toContain(outsider);
      expect(edited.excluded_peer_ids).toEqual(target.excluded_peer_ids);
    } finally {
      await removeFolderSources({
        folder_id: target.id,
        source_ids: [outsider!],
      });
    }

    const restored = await fetchFolders();
    expect(restored.find((f) => f.id === target.id)?.included_peer_ids).toEqual(
      target.included_peer_ids,
    );
  });

  it("sets and clears the manual unread flag, and shows it in the reads", async () => {
    const index = await fetchDialogIndex();
    const subject = [...index.byId.values()].find(
      (entry) => entry.unread_count === 0 && entry.unread_mark !== true,
    );
    expect(subject, "no read, unflagged dialog to use").toBeTruthy();

    const set = await markUnread({
      source_ids: [subject!.source_id],
      unread: true,
    });
    expect(set.failures).toEqual([]);

    try {
      const after = await fetchDialogIndex();
      expect(after.byId.get(subject!.source_id)?.unread_mark).toBe(true);

      const summary = await getUnreadSummary({});
      const group = summary.groups.find(
        (g) => g.source_id === subject!.source_id,
      );
      expect(
        group,
        "a flagged source is missing from the summary",
      ).toBeTruthy();
      expect(group!.unread_mark).toBe(true);
      expect(group!.unread_count).toBe(0);
    } finally {
      await markUnread({ source_ids: [subject!.source_id], unread: false });
    }

    const restored = await fetchDialogIndex();
    expect(restored.byId.get(subject!.source_id)?.unread_mark).toBeUndefined();
  });
});
