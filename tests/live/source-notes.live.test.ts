import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  deleteSourceNote,
  listSourceNotes,
  setSourceNote,
} from "@/telegram/source-notes";
import { listDialogs } from "@/telegram/dialogs";

const enabled = process.env.GRAMSCOPE_LIVE === "1";
const suite = enabled ? describe : describe.skip;

suite("source notes against the real account", () => {
  let target = "";

  beforeAll(async () => {
    if (!process.env.TELEGRAM_SESSION) {
      throw new Error("TELEGRAM_SESSION is required for live tests");
    }
    const { sources } = await listDialogs({ limit: 5, type: "channel" });
    if (sources.length === 0) throw new Error("the account follows no channel");
    target = sources[0]!.id;
  });

  // Runs even if an expectation failed mid-file: the next live run must start
  // from the same baseline this one did.
  afterAll(async () => {
    if (target) await deleteSourceNote(target);
    const cleanup = await listSourceNotes({});
    expect(cleanup.notes).toEqual([]);
    expect(cleanup.malformed).toEqual([]);
  });

  it("writes, reads, searches, overwrites and deletes one note", async () => {
    const written = await setSourceNote({
      source_id: target,
      about: "Live-tier probe note. **Not** parsed as markdown.",
      topics: ["gramscope-live-probe"],
      kind: "mixed",
      derived_from: "live test",
    });
    expect(written.replaced).toBe(false);
    expect(written.note.about).toContain("**Not**");
    expect(written.note.id).toBe(target);

    const all = await listSourceNotes({});
    expect(all.notes.map((n) => n.id)).toContain(target);
    expect(all.malformed).toEqual([]);
    expect(all.duplicates).toEqual([]);

    const byId = await listSourceNotes({ source_ids: [target] });
    expect(byId.notes).toHaveLength(1);
    expect(byId.notes[0]!.id).toBe(target);

    const found = await listSourceNotes({ query: "gramscope-live-probe" });
    expect(found.notes.map((n) => n.id)).toContain(target);

    const again = await setSourceNote({
      source_id: target,
      about: "Rewritten by the live tier.",
      topics: ["gramscope-live-probe"],
      kind: "reporting",
    });
    expect(again.replaced).toBe(true);
    expect(again.note.about).toBe("Rewritten by the live tier.");

    const afterOverwrite = await listSourceNotes({ source_ids: [target] });
    expect(afterOverwrite.notes).toHaveLength(1);
    expect(afterOverwrite.duplicates).toEqual([]);

    const removed = await deleteSourceNote(target);
    expect(removed.deleted).toBe(true);

    const empty = await listSourceNotes({});
    expect(empty.notes.map((n) => n.id)).not.toContain(target);
  });

  it("reports deleting a note that is not there without failing", async () => {
    const result = await deleteSourceNote(target);
    expect(result.deleted).toBe(false);
  });

  it("leaves Saved Messages holding no notes", async () => {
    const result = await listSourceNotes({});
    expect(result.notes).toEqual([]);
    expect(result.malformed).toEqual([]);
  });
});
