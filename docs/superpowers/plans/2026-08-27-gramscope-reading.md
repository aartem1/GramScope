# GramScope Reading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four MCP tools — `get_messages`, `get_message`, `get_unread_summary`, `mark_read` — so ChatGPT can read Telegram message content across a flexible set of sources and advance the read pointer.

**Architecture:** One `getDialogs` call per tool invocation builds a dialog index (titles, usernames, unread counts, read pointers, folder membership). `get_messages` resolves its source set from that index, fans out over the sources with a concurrency ceiling of 8, and assembles a grouped response that stops at the 256 KB cap, recording every unserved source in a per-source `offset_id` cursor. `mark_read` resolves each peer the same way reads do and calls `channels.readHistory` / `messages.readHistory`.

**Tech Stack:** TypeScript, Next.js 15 App Router on Vercel, `mcp-handler` ^2.1.1, `@modelcontextprotocol/server` ^2.0.0, `teleproto` ^1.229.0 (MTProto), `zod` ^4, `vitest` ^2.

**Spec:** `docs/superpowers/specs/2026-08-27-gramscope-reading-design.md`

## Global Constraints

- **Branch is `main`.** The owner works directly on `main` for this project; do not create a feature branch, do not ask.
- **`src/telegram/client.ts` is the only module permitted to import `teleproto`.** Everything else reaches MTProto through `withTelegram` and `getApi`.
- **`TelegramSource.id` and every `source_id` on the wire is Telegram's MARKED id** (`-100…` for channels, `-…` for legacy chats). Only `src/telegram/peer-id.ts` may construct or destructure either representation.
- **Cursors carry a kind discriminator `k`.** Dialog cursors are `"dialogs"`, message cursors are `"messages"`. A foreign cursor must fail as `INVALID_CURSOR`, never return a wrong page.
- **`MAX_RESPONSE_BYTES` is 256 KB** (`src/schemas/size.ts`), already defined. Never raise it.
- **Effective source cap is 25** for `get_messages` and `mark_read`. Exceeding it is `INVALID_INPUT` naming the count and telling the caller to split the call — never a silent truncation.
- **Fan-out concurrency ceiling is 8.**
- **`limit` on `get_messages` is per source:** default 20, min 1, max 100.
- **`context_before` / `context_after` on `get_message`:** 0–20 each, default 0.
- **`annotations.readOnlyHint` is derived from behaviour:** `true` on `list_dialogs`, `list_folders`, `get_channel`, `get_messages`, `get_message`, `get_unread_summary`; `false` on `mark_read`.
- **The error taxonomy in `src/errors/taxonomy.ts` does not change.** Use `INVALID_INPUT`, `INVALID_DATE_RANGE`, `INVALID_CURSOR`, `MESSAGE_NOT_FOUND`, and whatever `mapTelegramError` produces.
- **Per-source failure never fails the page.** In `get_messages` the source's block carries `error` instead of `messages`; in `mark_read` the source lands in `failures`.
- **Message text is never truncated.** Oversized pages are handled by the size cap, never by mutilating a message.
- **Media files are never downloaded.** Only metadata is returned.
- **Never print, log, or commit the Telegram session string, API hash, or any secret.** Secrets live only in gitignored `.env.local` and Vercel environment variables.
- **Gates:** `npm run test`, `npm run typecheck`, `npm run lint` must pass before every commit.

### Spec deviations resolved in this plan

Three fields listed in spec §6 are **omitted from the message schema**, because each either duplicates another field or costs a round trip per message, and §6's own stated reason for its field list is the 256 KB budget:

1. `media.caption` — in Telegram's TL a media message's caption **is** `message.message`, which this schema already returns as `text`. Emitting both duplicates every caption.
2. `author.username` — resolving a poster's username needs one `users.getUsers` per distinct author.
3. `forwarded_from.username` — same, per distinct forward origin.

Everything else in §6 is implemented exactly as written.

Two ambiguities in spec §5.1 are resolved as follows, and both are stated in the tool description so a caller learns them from `tools/list` rather than from a failed call:

- **A cursor supplies its own source set.** When `cursor` is present, `source_ids`, `folder_ids` and `exclude_source_ids` are ignored, and the cursor satisfies the "at least one of `source_ids` or `folder_ids`" rule. Every other filter (`from`, `to`, `unread_only`, `media_type`, `limit`) must be resent unchanged by the caller.
- **A source with no dialog entry cannot be unread-filtered.** `unread_only` needs a read pointer, which comes from the dialog list. A source absent from the dialog list is read in full instead of erroring.

One ambiguity in spec §5.3 is resolved: `get_unread_summary` returns **only groups with `unread_count > 0`**, sorted by `unread_count` descending, and `total_unread` counts every group in scope including any the size cap trimmed.

Spec §12 names one file `src/telegram/messages.ts` for slice fetching, date bounds, unread filtering, fan-out and budget assembly. This plan splits that responsibility across `src/telegram/message-slice.ts` (one source, one round trip) and `src/telegram/messages.ts` (many sources, budget, cursor), plus `src/concurrency.ts` for the bounded-parallelism helper. Same total responsibility, three reviewable units.

---

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `src/schemas/message.ts` | The `TelegramMessage` zod schema and the TL → schema mapper |
| `src/concurrency.ts` | `mapWithConcurrency` and the `FANOUT_CONCURRENCY` ceiling |
| `src/telegram/dialog-index.ts` | One `getDialogs` + `getDialogFilters` pass into a lookup by marked id; folder expansion |
| `src/telegram/message-slice.ts` | One source, one round trip: `getHistory` vs `search`, date bounds, unread stop, mapping |
| `src/telegram/messages.ts` | Source-set resolution, fan-out, size-cap assembly, message cursor, `getMessages`, `getMessage` |
| `src/telegram/unread.ts` | `getUnreadSummary`, built from the dialog index alone |
| `src/telegram/read-state.ts` | `markRead` — the one mutating path, isolated so it reviews on its own |
| `src/mcp/tools/get-messages.ts` | MCP registration for `get_messages` |
| `src/mcp/tools/get-message.ts` | MCP registration for `get_message` |
| `src/mcp/tools/get-unread-summary.ts` | MCP registration for `get_unread_summary` |
| `src/mcp/tools/mark-read.ts` | MCP registration for `mark_read` |
| `tests/schemas-message.test.ts` | Message mapper units |
| `tests/concurrency.test.ts` | Bounded parallelism units |
| `tests/telegram-dialog-index.test.ts` | Dialog index and folder expansion units |
| `tests/telegram-message-slice.test.ts` | Slice fetching units |
| `tests/telegram-messages.test.ts` | Fan-out, budget, cursor, error isolation units |
| `tests/telegram-unread.test.ts` | Unread summary units |
| `tests/telegram-read-state.test.ts` | `mark_read` units |
| `tests/mcp-handler.test.ts` | `tools/list` through a real `McpServer` over `InMemoryTransport` |
| `tests/live/access-hash.live.test.ts` | Task 1's live probe of the write path on a cold instance |
| `tests/live/reading.live.test.ts` | Live reading suite against the real account |

**Modified:**

| File | Change |
| --- | --- |
| `src/pagination.ts` | Generic `encodePayload` / `decodePayload(kind, schema)` plus dialog and message codecs |
| `src/telegram/client.ts` | `TelegramLike` gains `getMessages` |
| `src/mcp/server.ts` | Register the four new tools |
| `src/mcp/tool-result.ts` | `countOf` learns the grouped `sources`-with-`messages` shape |
| `app/api/mcp/route.ts` | `export const maxDuration = 60` |
| `tests/tools.test.ts` | Seven tools, `readOnlyHint` derived from behaviour |
| `tests/pagination.test.ts` | Message-cursor round trip and cross-kind rejection |
| `docs/superpowers/tasks/gramscope-mcp.md` | Close the `tools/list` review finding; record findings |

---

## Task 1: Verify the write path on a cold instance

Spec §10 argues from teleproto's source that resolving a peer from a bare id works for writes as well as reads. Nothing may be built on that until it is observed against the real account. The probe is a **no-op write**: `channels.readHistory` with `maxId` set to the channel's *current* `read_inbox_max_id` changes no state, but it is a real write RPC and fails with `CHANNEL_INVALID` if Telegram rejects an access hash resolved from zero.

**Files:**
- Test: `tests/live/access-hash.live.test.ts`

**Interfaces:**
- Consumes: `withTelegram`, `getApi`, `__resetClientForTests` from `src/telegram/client.ts`; `listDialogs` from `src/telegram/dialogs.ts`.
- Produces: a recorded finding. If the probe fails, every later task that calls `channels.readHistory` must instead resolve the peer through `client.getDialogs()` and reuse the `InputPeer` from the dialog — record that in the ledger and carry it into Task 9.

- [ ] **Step 1: Write the live probe**

Create `tests/live/access-hash.live.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import {
  __resetClientForTests,
  getApi,
  withTelegram,
} from "@/telegram/client";
import { listDialogs } from "@/telegram/dialogs";

const enabled = process.env.GRAMSCOPE_LIVE === "1";
const suite = enabled ? describe : describe.skip;

// Spec §10: the write path is assumed to resolve a peer from a marked id with
// access_hash = 0, exactly as reads do. This file is the observation that
// turns the assumption into a fact, and it runs before anything depends on it.
suite("access-hash resolution on a cold instance", () => {
  beforeAll(() => {
    if (!process.env.TELEGRAM_SESSION) {
      throw new Error("TELEGRAM_SESSION is required for live tests");
    }
  });

  it("accepts channels.readHistory for a peer resolved from a marked id", async () => {
    const { sources } = await listDialogs({ limit: 50, type: "channel" });
    const target = sources.find(
      (s) => typeof s.read_inbox_max_id === "number" && s.read_inbox_max_id > 0,
    );
    if (!target) {
      throw new Error(
        "the account has no channel with a read pointer; open one in Telegram before running this probe",
      );
    }

    // Drop the warm client so the peer must be resolved over the network from
    // its marked id alone. A warm _entityCache would hide the very failure
    // this probe exists to find.
    __resetClientForTests();

    const result = await withTelegram(async (client) => {
      const Api = await getApi();
      const entity = await client.getEntity(target.id);
      expect(entity.className).toBe("Channel");
      // maxId = the pointer's current value: a real write RPC that moves
      // nothing. Telegram still validates the access hash.
      return client.invoke(
        new Api.channels.ReadHistory({
          channel: entity as never,
          maxId: target.read_inbox_max_id!,
        }),
      );
    });

    expect(result).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the probe**

Run: `GRAMSCOPE_LIVE=1 npx vitest run tests/live/access-hash.live.test.ts`
Expected: PASS.

If it fails with `CHANNEL_NOT_FOUND` / `PRIVATE_CHANNEL_NOT_ACCESSIBLE`, the spec §10 assumption is wrong. Record that in the ledger, and Task 9 must resolve peers from `client.getDialogs()` results instead of `client.getEntity`. Do not proceed by guessing which it is — run the probe.

- [ ] **Step 3: Commit**

```bash
git add tests/live/access-hash.live.test.ts
git commit -m "test: probe the Telegram write path on a cold instance"
```

---

## Task 2: Message schema and TL mapper

**Files:**
- Create: `src/schemas/message.ts`
- Test: `tests/schemas-message.test.ts`

**Interfaces:**
- Consumes: `readBigId`, `inputPeerMarkedId` from `src/telegram/peer-id.ts`.
- Produces:
  - `telegramMessageSchema` (zod object)
  - `type TelegramMessage = z.infer<typeof telegramMessageSchema>`
  - `type MessageContext = { chatId: string; username?: string; readInboxMaxId?: number }`
  - `isoFromUnix(seconds: unknown): string | undefined`
  - `mediaOf(media: unknown): TelegramMessage["media"] | undefined`
  - `reactionsOf(raw: unknown): TelegramMessage["reactions"] | undefined`
  - `forwardedFromOf(raw: unknown): TelegramMessage["forwarded_from"] | undefined`
  - `mapMessage(raw: unknown, ctx: MessageContext): TelegramMessage`

- [ ] **Step 1: Write the failing test**

Create `tests/schemas-message.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  isoFromUnix,
  mapMessage,
  mediaOf,
  reactionsOf,
  telegramMessageSchema,
} from "@/schemas/message";

const CHAT_ID = "-1001234567890";

// A real broadcast post: text, views, forwards, reactions, a forward header
// and a document. One fixture that exercises every optional branch at once,
// because a mapper that drops a field usually drops it silently.
const richMessage = {
  className: "Message",
  id: 4242,
  date: 1735689600, // 2025-01-01T00:00:00Z
  editDate: 1735693200,
  message: "Model weights are out",
  views: 12000,
  forwards: 34,
  replies: { className: "MessageReplies", replies: 7 },
  reactions: {
    className: "MessageReactions",
    results: [
      { reaction: { className: "ReactionEmoji", emoticon: "🔥" }, count: 9 },
      { reaction: { className: "ReactionEmoji", emoticon: "👍" }, count: 3 },
    ],
  },
  fwdFrom: {
    className: "MessageFwdHeader",
    date: 1735686000,
    fromId: { className: "PeerChannel", channelId: { value: 555n } },
    fromName: "Upstream Channel",
    channelPost: 99,
  },
  media: {
    className: "MessageMediaDocument",
    document: {
      className: "Document",
      mimeType: "application/pdf",
      size: { value: 204800n },
      attributes: [
        { className: "DocumentAttributeFilename", fileName: "paper.pdf" },
      ],
    },
  },
};

describe("isoFromUnix", () => {
  it("renders a unix second as ISO 8601", () => {
    expect(isoFromUnix(1735689600)).toBe("2025-01-01T00:00:00.000Z");
  });

  it("returns undefined for absent or non-positive input", () => {
    expect(isoFromUnix(undefined)).toBeUndefined();
    expect(isoFromUnix(0)).toBeUndefined();
    expect(isoFromUnix("nope")).toBeUndefined();
  });
});

describe("mediaOf", () => {
  it("names a photo", () => {
    expect(mediaOf({ className: "MessageMediaPhoto" })).toEqual({
      type: "photo",
    });
  });

  it("names a web page preview url", () => {
    expect(mediaOf({ className: "MessageMediaWebPage" })).toEqual({
      type: "url",
    });
  });

  it("reads document metadata without downloading anything", () => {
    expect(mediaOf(richMessage.media)).toEqual({
      type: "document",
      file_name: "paper.pdf",
      mime_type: "application/pdf",
      size: 204800,
    });
  });

  it("calls an animated document a gif, not a video", () => {
    // An animation carries BOTH DocumentAttributeAnimated and
    // DocumentAttributeVideo. Checking video first mislabels every gif.
    expect(
      mediaOf({
        className: "MessageMediaDocument",
        document: {
          mimeType: "video/mp4",
          attributes: [
            { className: "DocumentAttributeVideo" },
            { className: "DocumentAttributeAnimated" },
          ],
        },
      }),
    ).toMatchObject({ type: "gif" });
  });

  it("distinguishes a voice note from music", () => {
    const voice = mediaOf({
      className: "MessageMediaDocument",
      document: {
        attributes: [{ className: "DocumentAttributeAudio", voice: true }],
      },
    });
    const music = mediaOf({
      className: "MessageMediaDocument",
      document: {
        attributes: [{ className: "DocumentAttributeAudio", voice: false }],
      },
    });
    expect(voice).toMatchObject({ type: "voice" });
    expect(music).toMatchObject({ type: "audio" });
  });

  it("falls back to the TL name for media it has no opinion about", () => {
    expect(mediaOf({ className: "MessageMediaPoll" })).toEqual({
      type: "poll",
    });
  });

  it("returns undefined when there is no media", () => {
    expect(mediaOf(undefined)).toBeUndefined();
  });
});

describe("reactionsOf", () => {
  it("flattens emoji reactions with their counts", () => {
    expect(reactionsOf(richMessage.reactions)).toEqual([
      { emoji: "🔥", count: 9 },
      { emoji: "👍", count: 3 },
    ]);
  });

  it("returns undefined when there are none", () => {
    expect(reactionsOf({ results: [] })).toBeUndefined();
    expect(reactionsOf(undefined)).toBeUndefined();
  });
});

describe("mapMessage", () => {
  it("maps a rich message and validates against the schema", () => {
    const mapped = mapMessage(richMessage, {
      chatId: CHAT_ID,
      username: "ainews",
      readInboxMaxId: 4000,
    });

    expect(telegramMessageSchema.parse(mapped)).toEqual(mapped);
    expect(mapped).toMatchObject({
      id: 4242,
      chat_id: CHAT_ID,
      date: "2025-01-01T00:00:00.000Z",
      edit_date: "2025-01-01T01:00:00.000Z",
      text: "Model weights are out",
      url: "https://t.me/ainews/4242",
      views: 12000,
      forwards: 34,
      replies: 7,
      media: { type: "document", file_name: "paper.pdf" },
      forwarded_from: {
        chat_id: "-100555",
        title: "Upstream Channel",
        message_id: 99,
        date: "2024-12-31T23:00:00.000Z",
      },
      is_read: false,
    });
  });

  it("marks a message at or below the read pointer as read", () => {
    const read = mapMessage({ id: 100, date: 1735689600 }, {
      chatId: CHAT_ID,
      readInboxMaxId: 100,
    });
    const unread = mapMessage({ id: 101, date: 1735689600 }, {
      chatId: CHAT_ID,
      readInboxMaxId: 100,
    });
    expect(read.is_read).toBe(true);
    expect(unread.is_read).toBe(false);
  });

  it("omits is_read when no read pointer is known", () => {
    const mapped = mapMessage({ id: 1, date: 1735689600 }, { chatId: CHAT_ID });
    expect(mapped.is_read).toBeUndefined();
  });

  it("omits url for a source with no username", () => {
    const mapped = mapMessage({ id: 1, date: 1735689600 }, { chatId: CHAT_ID });
    expect(mapped.url).toBeUndefined();
  });

  it("does not repeat the caption: media text lives in text only", () => {
    // Telegram stores a caption in Message.message, the same field as a text
    // post. Emitting it twice is the largest avoidable cost in a 256KB page.
    const mapped = mapMessage(
      { id: 1, date: 1735689600, message: "look", media: { className: "MessageMediaPhoto" } },
      { chatId: CHAT_ID },
    );
    expect(mapped.text).toBe("look");
    expect(JSON.stringify(mapped.media)).not.toContain("look");
  });

  it("carries the poster's signature as the author name", () => {
    const mapped = mapMessage(
      {
        id: 1,
        date: 1735689600,
        postAuthor: "Ada",
        fromId: { className: "PeerUser", userId: { value: 777n } },
      },
      { chatId: CHAT_ID },
    );
    expect(mapped.author).toEqual({ id: "777", name: "Ada" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/schemas-message.test.ts`
Expected: FAIL — `Failed to resolve import "@/schemas/message"`.

- [ ] **Step 3: Write the schema and mapper**

Create `src/schemas/message.ts`:

```ts
import { z } from "zod";
import { inputPeerMarkedId, readBigId } from "../telegram/peer-id";

/**
 * Three fields from the design's §6 sketch are deliberately absent.
 *
 * `media.caption`: in TL a caption IS `Message.message`, already returned as
 * `text`. `author.username` and `forwarded_from.username`: each would cost one
 * `users.getUsers` per distinct author or origin. All three are omissions in
 * service of the 256KB page budget, which is what §6 exists to protect.
 */
export const telegramMessageSchema = z.object({
  id: z.number().int(),
  chat_id: z.string(),
  date: z.string(),
  edit_date: z.string().optional(),
  text: z.string().optional(),
  url: z.string().optional(),
  author: z
    .object({ id: z.string().optional(), name: z.string().optional() })
    .optional(),
  views: z.number().int().optional(),
  forwards: z.number().int().optional(),
  replies: z.number().int().optional(),
  reactions: z
    .array(z.object({ emoji: z.string(), count: z.number().int() }))
    .optional(),
  forwarded_from: z
    .object({
      chat_id: z.string().optional(),
      title: z.string().optional(),
      message_id: z.number().int().optional(),
      date: z.string().optional(),
    })
    .optional(),
  media: z
    .object({
      type: z.string(),
      file_name: z.string().optional(),
      mime_type: z.string().optional(),
      size: z.number().int().optional(),
    })
    .optional(),
  is_read: z.boolean().optional(),
});

export type TelegramMessage = z.infer<typeof telegramMessageSchema>;

/** Facts about the source that a `Message` TL object does not carry itself. */
export type MessageContext = {
  chatId: string;
  username?: string;
  readInboxMaxId?: number;
};

export function isoFromUnix(seconds: unknown): string | undefined {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  return new Date(seconds * 1000).toISOString();
}

function attributesOf(document: Record<string, unknown>) {
  return Array.isArray(document.attributes)
    ? (document.attributes as Record<string, unknown>[])
    : [];
}

/**
 * Order matters: an animation carries DocumentAttributeVideo as well as
 * DocumentAttributeAnimated, and a sticker carries one too. Checking video
 * first would label every gif and sticker a video.
 */
function documentType(document: Record<string, unknown>): string {
  const attributes = attributesOf(document);
  const names = new Set(attributes.map((a) => String(a.className ?? "")));
  if (names.has("DocumentAttributeAnimated")) return "gif";
  if (names.has("DocumentAttributeSticker")) return "sticker";
  if (names.has("DocumentAttributeVideo")) return "video";
  const audio = attributes.find(
    (a) => a.className === "DocumentAttributeAudio",
  );
  if (audio) return audio.voice === true ? "voice" : "audio";
  return "document";
}

export function mediaOf(media: unknown): TelegramMessage["media"] | undefined {
  if (typeof media !== "object" || media === null) return undefined;
  const m = media as Record<string, unknown>;
  const name = typeof m.className === "string" ? m.className : "";

  if (name === "MessageMediaPhoto") return { type: "photo" };
  if (name === "MessageMediaWebPage") return { type: "url" };

  if (name === "MessageMediaDocument") {
    const document = (m.document ?? {}) as Record<string, unknown>;
    const named = attributesOf(document).find(
      (a) => a.className === "DocumentAttributeFilename",
    );
    const rawSize = readBigId(document.size);
    const size = rawSize === undefined ? Number.NaN : Number(rawSize);
    return {
      type: documentType(document),
      ...(typeof named?.fileName === "string"
        ? { file_name: named.fileName }
        : {}),
      ...(typeof document.mimeType === "string"
        ? { mime_type: document.mimeType }
        : {}),
      ...(Number.isSafeInteger(size) ? { size } : {}),
    };
  }

  if (name.startsWith("MessageMedia")) {
    return { type: name.slice("MessageMedia".length).toLowerCase() };
  }
  return undefined;
}

export function reactionsOf(
  raw: unknown,
): TelegramMessage["reactions"] | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const results = (raw as { results?: unknown }).results;
  if (!Array.isArray(results)) return undefined;

  const out = (results as Record<string, unknown>[]).flatMap((entry) => {
    const reaction = (entry.reaction ?? {}) as Record<string, unknown>;
    const emoji =
      typeof reaction.emoticon === "string"
        ? reaction.emoticon
        : readBigId(reaction.documentId);
    const count = typeof entry.count === "number" ? entry.count : undefined;
    return emoji !== undefined && count !== undefined
      ? [{ emoji, count }]
      : [];
  });
  return out.length > 0 ? out : undefined;
}

export function forwardedFromOf(
  raw: unknown,
): TelegramMessage["forwarded_from"] | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const f = raw as Record<string, unknown>;

  const chatId = inputPeerMarkedId(f.fromId);
  const title = typeof f.fromName === "string" ? f.fromName : undefined;
  const messageId =
    typeof f.channelPost === "number" ? f.channelPost : undefined;
  const date = isoFromUnix(f.date);

  const out = {
    ...(chatId !== undefined ? { chat_id: chatId } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(messageId !== undefined ? { message_id: messageId } : {}),
    ...(date !== undefined ? { date } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

export function mapMessage(
  raw: unknown,
  ctx: MessageContext,
): TelegramMessage {
  const m = (raw ?? {}) as Record<string, unknown>;
  const id = typeof m.id === "number" ? m.id : 0;
  const text =
    typeof m.message === "string" && m.message.length > 0
      ? m.message
      : undefined;
  const editDate = isoFromUnix(m.editDate);
  const authorId = inputPeerMarkedId(m.fromId);
  const authorName =
    typeof m.postAuthor === "string" ? m.postAuthor : undefined;
  const replies = (m.replies ?? {}) as Record<string, unknown>;
  const reactions = reactionsOf(m.reactions);
  const forwardedFrom = forwardedFromOf(m.fwdFrom);
  const media = mediaOf(m.media);

  return {
    id,
    chat_id: ctx.chatId,
    date: isoFromUnix(m.date) ?? new Date(0).toISOString(),
    ...(editDate !== undefined ? { edit_date: editDate } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(ctx.username ? { url: `https://t.me/${ctx.username}/${id}` } : {}),
    ...(authorId !== undefined || authorName !== undefined
      ? {
          author: {
            ...(authorId !== undefined ? { id: authorId } : {}),
            ...(authorName !== undefined ? { name: authorName } : {}),
          },
        }
      : {}),
    ...(typeof m.views === "number" ? { views: m.views } : {}),
    ...(typeof m.forwards === "number" ? { forwards: m.forwards } : {}),
    ...(typeof replies.replies === "number"
      ? { replies: replies.replies }
      : {}),
    ...(reactions !== undefined ? { reactions } : {}),
    ...(forwardedFrom !== undefined ? { forwarded_from: forwardedFrom } : {}),
    ...(media !== undefined ? { media } : {}),
    ...(ctx.readInboxMaxId !== undefined
      ? { is_read: id <= ctx.readInboxMaxId }
      : {}),
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/schemas-message.test.ts && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/schemas/message.ts tests/schemas-message.test.ts
git commit -m "feat: add the Telegram message schema and TL mapper"
```

---

## Task 3: Generic cursor envelope and the message cursor

**Files:**
- Modify: `src/pagination.ts` (whole file rewritten; the two exported dialog functions keep their names and behaviour)
- Test: `tests/pagination.test.ts` (extended)

**Interfaces:**
- Consumes: `GramScopeError` from `src/errors/taxonomy.ts`.
- Produces, in addition to the existing `CURSOR_VERSION`, `DIALOG_CURSOR_KIND`, `DialogCursor`, `encodeCursor(cursor: DialogCursor): string`, `decodeCursor(raw: string): DialogCursor`:
  - `MESSAGE_CURSOR_KIND = "messages"`
  - `type MessageCursor = { sources: Array<{ sourceId: string; offsetId: number }> }`
  - `encodeMessageCursor(cursor: MessageCursor): string`
  - `decodeMessageCursor(raw: string): MessageCursor`
  - `offsetId: 0` means "start from the newest message".

- [ ] **Step 1: Write the failing test**

Append to `tests/pagination.test.ts`:

```ts
import {
  decodeMessageCursor,
  encodeMessageCursor,
  type MessageCursor,
} from "@/pagination";

const messageCursor: MessageCursor = {
  sources: [
    { sourceId: "-1001234567890", offsetId: 4242 },
    { sourceId: "-1009876543210", offsetId: 0 },
  ],
};

describe("message cursors", () => {
  it("round-trips a per-source offset list", () => {
    expect(decodeMessageCursor(encodeMessageCursor(messageCursor))).toEqual(
      messageCursor,
    );
  });

  it("carries its own kind discriminator", () => {
    const decoded: unknown = JSON.parse(
      Buffer.from(encodeMessageCursor(messageCursor), "base64url").toString(
        "utf8",
      ),
    );
    expect(decoded).toMatchObject({ k: "messages" });
  });

  it("refuses a dialog cursor rather than returning a wrong page", () => {
    const error = (() => {
      try {
        decodeMessageCursor(encodeCursor(cursor));
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(GramScopeError);
    expect((error as GramScopeError).code).toBe("INVALID_CURSOR");
  });

  it("refuses a message cursor at the dialog decoder", () => {
    expect(() => decodeCursor(encodeMessageCursor(messageCursor))).toThrowError(
      GramScopeError,
    );
  });

  it("refuses a future version", () => {
    const forged = Buffer.from(
      JSON.stringify({ v: 99, k: "messages", s: [] }),
    ).toString("base64url");
    expect(() => decodeMessageCursor(forged)).toThrowError(GramScopeError);
  });

  it("refuses a structurally wrong payload", () => {
    const forged = Buffer.from(
      JSON.stringify({ v: 1, k: "messages", s: [{ i: 1, o: "x" }] }),
    ).toString("base64url");
    expect(() => decodeMessageCursor(forged)).toThrowError(GramScopeError);
  });
});
```

Merge the new imports into the file's existing `import { decodeCursor, encodeCursor, type DialogCursor } from "@/pagination";` line rather than adding a second import statement.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/pagination.test.ts`
Expected: FAIL — `encodeMessageCursor is not exported`.

- [ ] **Step 3: Rewrite `src/pagination.ts`**

```ts
import { z } from "zod";
import { GramScopeError } from "./errors/taxonomy";

export const CURSOR_VERSION = 1;

/**
 * Cursors from different tools share this envelope shape, so without a
 * discriminator a message cursor would decode cleanly at the dialog decoder
 * and silently return the wrong page.
 */
export const DIALOG_CURSOR_KIND = "dialogs";
export const MESSAGE_CURSOR_KIND = "messages";

const envelopeSchema = z.object({
  v: z.literal(CURSOR_VERSION),
  k: z.string(),
});

function encodePayload(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * Decodes one cursor kind. The envelope is checked before the body so a
 * foreign or outdated cursor is rejected on identity rather than on whichever
 * field happens to differ.
 */
function decodePayload<S extends z.ZodType>(
  raw: string,
  kind: string,
  schema: S,
): z.infer<S> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new GramScopeError("INVALID_CURSOR", "Cursor is not decodable");
  }

  const envelope = envelopeSchema.safeParse(parsed);
  if (!envelope.success || envelope.data.k !== kind) {
    throw new GramScopeError(
      "INVALID_CURSOR",
      "Cursor is from another tool or an unsupported version",
    );
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new GramScopeError("INVALID_CURSOR", "Cursor is malformed");
  }
  return result.data;
}

/**
 * Telegram resumes getDialogs from offset_date + offset_id + offset_peer, but
 * offset_peer must be a real InputPeer TL object carrying an access hash, and
 * a stateless server has no entity cache to rebuild one from. We therefore
 * paginate on date + id only.
 */
export type DialogCursor = {
  offsetDate: number;
  offsetId: number;
  /**
   * Ids already served whose dialog shares offsetDate. Telegram returns
   * dialogs with date <= offset_date INCLUSIVE, and offset_peer — the field
   * that would disambiguate the boundary — cannot be rebuilt by a stateless
   * server. Without this the boundary dialog is served twice.
   */
  boundaryIds: string[];
};

const dialogPayloadSchema = z.object({
  v: z.literal(CURSOR_VERSION),
  k: z.literal(DIALOG_CURSOR_KIND),
  d: z.number().int(),
  i: z.number().int(),
  b: z.array(z.string()).default([]),
});

export function encodeCursor(cursor: DialogCursor): string {
  return encodePayload({
    v: CURSOR_VERSION,
    k: DIALOG_CURSOR_KIND,
    d: cursor.offsetDate,
    i: cursor.offsetId,
    b: cursor.boundaryIds,
  });
}

export function decodeCursor(raw: string): DialogCursor {
  const payload = decodePayload(raw, DIALOG_CURSOR_KIND, dialogPayloadSchema);
  return {
    offsetDate: payload.d,
    offsetId: payload.i,
    boundaryIds: payload.b,
  };
}

/**
 * Message ids inside one peer are strictly monotonic, so an offset_id is an
 * exact resume point: there is no boundary tie to disambiguate and therefore
 * no boundaryIds equivalent here. `offsetId: 0` means "start from the newest".
 */
export type MessageCursor = {
  sources: Array<{ sourceId: string; offsetId: number }>;
};

const messagePayloadSchema = z.object({
  v: z.literal(CURSOR_VERSION),
  k: z.literal(MESSAGE_CURSOR_KIND),
  s: z.array(z.object({ i: z.string(), o: z.number().int() })),
});

export function encodeMessageCursor(cursor: MessageCursor): string {
  return encodePayload({
    v: CURSOR_VERSION,
    k: MESSAGE_CURSOR_KIND,
    s: cursor.sources.map((source) => ({
      i: source.sourceId,
      o: source.offsetId,
    })),
  });
}

export function decodeMessageCursor(raw: string): MessageCursor {
  const payload = decodePayload(raw, MESSAGE_CURSOR_KIND, messagePayloadSchema);
  return {
    sources: payload.s.map((source) => ({
      sourceId: source.i,
      offsetId: source.o,
    })),
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/pagination.test.ts tests/telegram-dialogs.test.ts && npm run typecheck && npm run lint`
Expected: PASS. The dialog suite must stay green — this refactor changes no dialog behaviour.

- [ ] **Step 5: Commit**

```bash
git add src/pagination.ts tests/pagination.test.ts
git commit -m "refactor: make the cursor envelope generic and add a message cursor"
```

---

## Task 4: Bounded parallelism helper

**Files:**
- Create: `src/concurrency.ts`
- Test: `tests/concurrency.test.ts`

**Interfaces:**
- Produces:
  - `FANOUT_CONCURRENCY = 8`
  - `mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]>` — results in input order, at most `limit` calls to `fn` in flight.

- [ ] **Step 1: Write the failing test**

Create `tests/concurrency.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FANOUT_CONCURRENCY, mapWithConcurrency } from "@/concurrency";

describe("mapWithConcurrency", () => {
  it("preserves input order regardless of completion order", async () => {
    const items = [30, 10, 20, 0];
    const results = await mapWithConcurrency(items, 4, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms;
    });
    expect(results).toEqual(items);
  });

  it("never runs more than the ceiling at once", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 25 }, (_, i) => i),
      8,
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return 0;
      },
    );
    expect(peak).toBeLessThanOrEqual(8);
    expect(peak).toBeGreaterThan(1);
  });

  it("returns an empty array for no items", async () => {
    expect(await mapWithConcurrency([], 8, async () => 1)).toEqual([]);
  });

  it("rejects when a worker rejects", async () => {
    await expect(
      mapWithConcurrency([1, 2], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });

  it("uses a ceiling of 8 for the Telegram fan-out", () => {
    // 25 sources on one MTProto connection is what this ceiling exists to
    // prevent; the number is spec §7, not taste.
    expect(FANOUT_CONCURRENCY).toBe(8);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/concurrency.test.ts`
Expected: FAIL — `Failed to resolve import "@/concurrency"`.

- [ ] **Step 3: Write the implementation**

Create `src/concurrency.ts`:

```ts
/**
 * Spec §7: 25 sources must not become 25 simultaneous MTProto requests on one
 * connection.
 */
export const FANOUT_CONCURRENCY = 8;

/**
 * Runs `fn` over `items` with at most `limit` calls in flight, returning
 * results in input order. Rejects as soon as any call rejects; callers that
 * need per-item failure isolation catch inside `fn` and return a value.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from(
    { length: Math.max(0, Math.min(limit, items.length)) },
    async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await fn(items[index]!);
      }
    },
  );

  await Promise.all(workers);
  return results;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/concurrency.test.ts && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/concurrency.ts tests/concurrency.test.ts
git commit -m "feat: add a bounded-parallelism helper for the source fan-out"
```

---

## Task 5: Dialog index and folder expansion

Every tool in this sub-project needs the same facts about a source: its title, its username (for message URLs), its unread count, its read pointer, its latest message, and which folders it belongs to. Spec §5.3 and §9 both require these to come from **one** `getDialogs` call per tool invocation, not one call per source.

**Files:**
- Create: `src/telegram/dialog-index.ts`
- Test: `tests/telegram-dialog-index.test.ts`

**Interfaces:**
- Consumes: `withTelegram` from `src/telegram/client.ts`; `fetchFolders` from `src/telegram/folders.ts`; `foldersByPeer`, `mapDialog` from `src/telegram/dialogs.ts`; `isoFromUnix` from `src/schemas/message.ts`; `GramScopeError` from `src/errors/taxonomy.ts`; `TelegramFolder` from `src/schemas/folder.ts`.
- Produces:
  - `type DialogEntry = { source_id: string; title: string; username?: string; unread_count: number; read_inbox_max_id: number; latest_message_id?: number; latest_message_date?: string; folder_ids: string[] }`
  - `type DialogIndex = { byId: Map<string, DialogEntry>; folders: TelegramFolder[] }`
  - `toEntry(dialog: unknown, folderIndex: Map<string, string[]>): DialogEntry`
  - `folderMembers(folders: TelegramFolder[], folderIds: string[]): string[]` — throws `INVALID_INPUT` on an unknown folder id
  - `fetchDialogIndex(): Promise<DialogIndex>`

- [ ] **Step 1: Write the failing test**

Create `tests/telegram-dialog-index.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import {
  fetchDialogIndex,
  folderMembers,
  toEntry,
} from "@/telegram/dialog-index";
import {
  __resetClientForTests,
  __setClientFactoryForTests,
} from "@/telegram/client";
import { GramScopeError } from "@/errors/taxonomy";

const AI_NEWS_ID = "-1001234567890";
const TECH_ID = "-1009876543210";

const aiNewsDialog = {
  id: { value: -1001234567890n },
  title: "AI News",
  unreadCount: 5,
  entity: {
    className: "Channel",
    id: { value: 1234567890n },
    username: "ainews",
  },
  dialog: { readInboxMaxId: 900 },
  message: { id: 905, date: 1735689600 },
};

const techDialog = {
  id: { value: -1009876543210n },
  title: "Tech",
  unreadCount: 0,
  entity: { className: "Channel", id: { value: 9876543210n } },
  dialog: { readInboxMaxId: 40 },
  message: { id: 40, date: 1735603200 },
};

const folders = [
  {
    id: "2",
    title: "AI",
    includePeers: [{ channelId: { value: 1234567890n } }],
    excludePeers: [],
  },
];

function fakeClient(dialogs: unknown[]) {
  return {
    connected: true,
    connect: async () => true,
    invoke: async () => ({ filters: folders }),
    getDialogs: async () => dialogs,
    getEntity: async () => ({}),
    getMessages: async () => [],
  };
}

afterEach(() => {
  __setClientFactoryForTests(undefined);
  __resetClientForTests();
});

describe("toEntry", () => {
  it("carries the pointer, the latest message and folder membership", () => {
    const entry = toEntry(aiNewsDialog, new Map([[AI_NEWS_ID, ["2"]]]));
    expect(entry).toEqual({
      source_id: AI_NEWS_ID,
      title: "AI News",
      username: "ainews",
      unread_count: 5,
      read_inbox_max_id: 900,
      latest_message_id: 905,
      latest_message_date: "2025-01-01T00:00:00.000Z",
      folder_ids: ["2"],
    });
  });

  it("defaults an absent unread count and pointer to zero", () => {
    const entry = toEntry(
      { id: { value: -100111n }, title: "X", entity: { className: "Channel", id: { value: 111n } } },
      new Map(),
    );
    expect(entry.unread_count).toBe(0);
    expect(entry.read_inbox_max_id).toBe(0);
    expect(entry.folder_ids).toEqual([]);
  });
});

describe("folderMembers", () => {
  const parsed = [
    {
      id: "2",
      title: "AI",
      included_peer_ids: [AI_NEWS_ID, TECH_ID],
      excluded_peer_ids: [TECH_ID],
      order: 0,
    },
  ];

  it("expands a folder to its included minus excluded peers", () => {
    expect(folderMembers(parsed, ["2"])).toEqual([AI_NEWS_ID]);
  });

  it("rejects an unknown folder id", () => {
    const error = (() => {
      try {
        folderMembers(parsed, ["99"]);
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(GramScopeError);
    expect((error as GramScopeError).code).toBe("INVALID_INPUT");
  });
});

describe("fetchDialogIndex", () => {
  it("indexes every dialog by its marked id in one pass", async () => {
    __setClientFactoryForTests(async () =>
      fakeClient([aiNewsDialog, techDialog]),
    );
    const index = await fetchDialogIndex();
    expect([...index.byId.keys()].sort()).toEqual(
      [AI_NEWS_ID, TECH_ID].sort(),
    );
    expect(index.byId.get(AI_NEWS_ID)?.read_inbox_max_id).toBe(900);
    expect(index.folders.map((f) => f.id)).toEqual(["2"]);
  });

  it("calls getDialogs once, not once per source", async () => {
    let calls = 0;
    __setClientFactoryForTests(async () => ({
      ...fakeClient([aiNewsDialog, techDialog]),
      getDialogs: async () => {
        calls++;
        return [aiNewsDialog, techDialog];
      },
    }));
    await fetchDialogIndex();
    expect(calls).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/telegram-dialog-index.test.ts`
Expected: FAIL — `Failed to resolve import "@/telegram/dialog-index"`.

- [ ] **Step 3: Write the implementation**

Create `src/telegram/dialog-index.ts`:

```ts
import { withTelegram } from "./client";
import { foldersByPeer, mapDialog } from "./dialogs";
import { fetchFolders } from "./folders";
import { isoFromUnix } from "../schemas/message";
import { GramScopeError } from "../errors/taxonomy";
import type { TelegramFolder } from "../schemas/folder";

/**
 * Telegram folders cap at 100 chats each (200 Premium) across at most 20
 * folders, so a single scan of this depth covers any account this server is
 * meant for, and every tool in the reading set then costs one getDialogs call
 * rather than one per source.
 */
const DIALOG_SCAN_LIMIT = 500;

export type DialogEntry = {
  source_id: string;
  title: string;
  username?: string;
  unread_count: number;
  read_inbox_max_id: number;
  latest_message_id?: number;
  latest_message_date?: string;
  folder_ids: string[];
};

export type DialogIndex = {
  byId: Map<string, DialogEntry>;
  folders: TelegramFolder[];
};

export function toEntry(
  dialog: unknown,
  folderIndex: Map<string, string[]>,
): DialogEntry {
  const d = (dialog ?? {}) as Record<string, unknown>;
  const source = mapDialog(dialog, folderIndex);
  const message = (d.message ?? {}) as Record<string, unknown>;
  const latestDate = isoFromUnix(message.date);

  return {
    source_id: source.id,
    title: source.title,
    ...(source.username !== undefined ? { username: source.username } : {}),
    unread_count: source.unread_count ?? 0,
    read_inbox_max_id: source.read_inbox_max_id ?? 0,
    ...(typeof message.id === "number"
      ? { latest_message_id: message.id }
      : {}),
    ...(latestDate !== undefined ? { latest_message_date: latestDate } : {}),
    folder_ids: source.folder_ids ?? [],
  };
}

/**
 * A folder's members are its included peers minus its excluded ones. Its
 * exclude-muted / exclude-read / chat-type flags are ignored here for the same
 * reason list_dialogs ignores them: they depend on live state and would make
 * the same call return different sources on two consecutive runs.
 */
export function folderMembers(
  folders: TelegramFolder[],
  folderIds: string[],
): string[] {
  const members: string[] = [];
  for (const id of folderIds) {
    const folder = folders.find((f) => f.id === id);
    if (!folder) {
      throw new GramScopeError(
        "INVALID_INPUT",
        `No folder with id ${id}. Call list_folders for valid ids.`,
      );
    }
    const excluded = new Set(folder.excluded_peer_ids);
    for (const peer of folder.included_peer_ids) {
      if (!excluded.has(peer)) members.push(peer);
    }
  }
  return members;
}

export async function fetchDialogIndex(): Promise<DialogIndex> {
  const folders = await fetchFolders();
  const folderIndex = foldersByPeer(folders);
  const raw = await withTelegram(async (client) =>
    client.getDialogs({ limit: DIALOG_SCAN_LIMIT }),
  );

  const byId = new Map<string, DialogEntry>();
  for (const dialog of raw) {
    const entry = toEntry(dialog, folderIndex);
    if (entry.source_id) byId.set(entry.source_id, entry);
  }
  return { byId, folders };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/telegram-dialog-index.test.ts && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/dialog-index.ts tests/telegram-dialog-index.test.ts
git commit -m "feat: index dialogs once per tool call for titles, pointers and folders"
```

---

## Task 6: Per-source slice fetching

One source, one round trip. Spec §9: an untyped request uses `messages.getHistory`; a `media_type` request uses `messages.search` with an empty query and a TL filter. teleproto's `client.getMessages` selects between exactly those two based on whether a `filter` is passed, so both paths share one call site here.

Date and unread bounds are applied client-side as **stop conditions**, not filters: history arrives newest-first, so the first message older than `from`, or at or below the read pointer, ends the source. Applying them client-side also makes correctness independent of whether Telegram treats `offset_date` and `max_date` as inclusive or exclusive; the server-side `offsetDate` is an optimization that skips pages we would otherwise download and discard.

**Files:**
- Modify: `src/telegram/client.ts` — add `getMessages` to `TelegramLike`
- Create: `src/telegram/message-slice.ts`
- Test: `tests/telegram-message-slice.test.ts`

**Interfaces:**
- Consumes: `getApi`, `TelegramLike` from `src/telegram/client.ts`; `mapMessage`, `TelegramMessage` from `src/schemas/message.ts`.
- Produces:
  - `type MediaType = "photo" | "video" | "document" | "audio" | "voice" | "url" | "gif"`
  - `MEDIA_TYPES: readonly MediaType[]` — for the zod enum in Task 10
  - `type SliceRequest = { sourceId: string; username?: string; readInboxMaxId?: number; limit: number; offsetId: number; fromSeconds?: number; toSeconds?: number; unreadOnly?: boolean; mediaType?: MediaType }`
  - `type Slice = { messages: TelegramMessage[]; hasMore: boolean; nextOffsetId: number }`
  - `fetchSlice(client: TelegramLike, request: SliceRequest): Promise<Slice>`

- [ ] **Step 1: Add `getMessages` to `TelegramLike`**

In `src/telegram/client.ts`, extend the type:

```ts
export type TelegramLike = {
  connected?: boolean;
  connect(): Promise<boolean>;
  invoke(request: unknown): Promise<unknown>;
  getDialogs(params: Record<string, unknown>): Promise<unknown[]>;
  getEntity(entity: string): Promise<Record<string, unknown>>;
  getMessages(
    entity: string,
    params: Record<string, unknown>,
  ): Promise<unknown[]>;
};
```

Every existing fake client in `tests/` must gain a `getMessages` stub, or typecheck fails. Add `getMessages: async () => []` to the fakes in `tests/telegram-dialogs.test.ts` and `tests/telegram-client.test.ts` wherever a full `TelegramLike` is constructed.

- [ ] **Step 2: Write the failing test**

Create `tests/telegram-message-slice.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fetchSlice, type SliceRequest } from "@/telegram/message-slice";
import type { TelegramLike } from "@/telegram/client";

const SOURCE_ID = "-1001234567890";

/** Newest-first history, one message per hour ending 2025-01-01T00:00:00Z. */
function history(count: number, startId = 1000) {
  return Array.from({ length: count }, (_, i) => ({
    className: "Message",
    id: startId - i,
    date: 1735689600 - i * 3600,
    message: `post ${startId - i}`,
  }));
}

function client(
  messages: unknown[],
  seen?: (params: Record<string, unknown>) => void,
): TelegramLike {
  return {
    connected: true,
    connect: async () => true,
    invoke: async () => ({}),
    getDialogs: async () => [],
    getEntity: async () => ({}),
    getMessages: async (_entity, params) => {
      seen?.(params);
      const limit = typeof params.limit === "number" ? params.limit : 0;
      return messages.slice(0, limit);
    },
  };
}

const base: SliceRequest = { sourceId: SOURCE_ID, limit: 5, offsetId: 0 };

describe("fetchSlice", () => {
  it("returns mapped messages newest first", async () => {
    const slice = await fetchSlice(client(history(5)), base);
    expect(slice.messages.map((m) => m.id)).toEqual([
      1000, 999, 998, 997, 996,
    ]);
    expect(slice.messages[0]!.chat_id).toBe(SOURCE_ID);
  });

  it("reports exhaustion when Telegram returns fewer than the limit", async () => {
    const slice = await fetchSlice(client(history(3)), base);
    expect(slice.hasMore).toBe(false);
    expect(slice.nextOffsetId).toBe(0);
  });

  it("reports a resume point when the page is full", async () => {
    const slice = await fetchSlice(client(history(20)), base);
    expect(slice.hasMore).toBe(true);
    expect(slice.nextOffsetId).toBe(996);
  });

  it("stops at the lower date bound and calls the source exhausted", async () => {
    // from = 1735689600 - 2*3600, so ids 1000, 999, 998 are in range and 997
    // is the first one that predates it.
    const slice = await fetchSlice(client(history(20)), {
      ...base,
      fromSeconds: 1735689600 - 2 * 3600,
    });
    expect(slice.messages.map((m) => m.id)).toEqual([1000, 999, 998]);
    expect(slice.hasMore).toBe(false);
  });

  it("drops messages newer than the upper date bound", async () => {
    const slice = await fetchSlice(client(history(20)), {
      ...base,
      toSeconds: 1735689600 - 2 * 3600,
    });
    expect(slice.messages.map((m) => m.id)).toEqual([998, 997, 996]);
  });

  it("asks Telegram to skip past the upper bound on a first page", async () => {
    let params: Record<string, unknown> | undefined;
    await fetchSlice(
      client(history(5), (p) => {
        params = p;
      }),
      { ...base, toSeconds: 1735689600 },
    );
    // offset_date is "strictly before", so an inclusive `to` is to + 1.
    expect(params?.offsetDate).toBe(1735689601);
  });

  it("resumes from the cursor's offset instead of the date", async () => {
    let params: Record<string, unknown> | undefined;
    await fetchSlice(
      client(history(5), (p) => {
        params = p;
      }),
      { ...base, offsetId: 990, toSeconds: 1735689600 },
    );
    expect(params?.offsetId).toBe(990);
    expect(params?.offsetDate).toBeUndefined();
  });

  it("stops at the read pointer when unread_only is set", async () => {
    const slice = await fetchSlice(client(history(20)), {
      ...base,
      unreadOnly: true,
      readInboxMaxId: 997,
    });
    expect(slice.messages.map((m) => m.id)).toEqual([1000, 999, 998]);
    expect(slice.hasMore).toBe(false);
  });

  it("reads everything when unread_only is set but no pointer is known", async () => {
    const slice = await fetchSlice(client(history(3)), {
      ...base,
      unreadOnly: true,
    });
    expect(slice.messages).toHaveLength(3);
  });

  it("passes a TL filter for a typed media request", async () => {
    let params: Record<string, unknown> | undefined;
    await fetchSlice(
      client(history(3), (p) => {
        params = p;
      }),
      { ...base, mediaType: "photo" },
    );
    expect(
      (params?.filter as { className?: string } | undefined)?.className,
    ).toBe("InputMessagesFilterPhotos");
  });

  it("passes no filter for an untyped request", async () => {
    let params: Record<string, unknown> | undefined;
    await fetchSlice(
      client(history(3), (p) => {
        params = p;
      }),
      base,
    );
    expect(params?.filter).toBeUndefined();
  });

  it("skips service and empty messages", async () => {
    const slice = await fetchSlice(
      client([
        { className: "MessageService", id: 5, date: 1735689600 },
        { className: "MessageEmpty", id: 4, date: 1735689600 },
        { className: "Message", id: 3, date: 1735689600, message: "real" },
      ]),
      { ...base, limit: 3 },
    );
    expect(slice.messages.map((m) => m.id)).toEqual([3]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/telegram-message-slice.test.ts`
Expected: FAIL — `Failed to resolve import "@/telegram/message-slice"`.

- [ ] **Step 4: Write the implementation**

Create `src/telegram/message-slice.ts`:

```ts
import { getApi, type TelegramLike } from "./client";
import { mapMessage, type TelegramMessage } from "../schemas/message";

export const MEDIA_TYPES = [
  "photo",
  "video",
  "document",
  "audio",
  "voice",
  "url",
  "gif",
] as const;

export type MediaType = (typeof MEDIA_TYPES)[number];

export type SliceRequest = {
  sourceId: string;
  username?: string;
  readInboxMaxId?: number;
  limit: number;
  /** 0 means "start from the newest message". */
  offsetId: number;
  /** Inclusive lower bound on message date, unix seconds. */
  fromSeconds?: number;
  /** Inclusive upper bound on message date, unix seconds. */
  toSeconds?: number;
  unreadOnly?: boolean;
  mediaType?: MediaType;
};

export type Slice = {
  messages: TelegramMessage[];
  hasMore: boolean;
  /** Resume point for the next page; 0 when the source is exhausted. */
  nextOffsetId: number;
};

/**
 * messages.getHistory cannot filter by media type, so a typed request has to
 * go through messages.search with an empty query — the same primitive the
 * Telegram app uses for its media tabs. teleproto's getMessages picks Search
 * over GetHistory precisely when a filter is present, so passing one here is
 * the whole switch.
 */
async function mediaFilter(type: MediaType | undefined): Promise<unknown> {
  if (type === undefined) return undefined;
  const Api = await getApi();
  switch (type) {
    case "photo":
      return new Api.InputMessagesFilterPhotos();
    case "video":
      return new Api.InputMessagesFilterVideo();
    case "document":
      return new Api.InputMessagesFilterDocument();
    case "audio":
      return new Api.InputMessagesFilterMusic();
    case "voice":
      return new Api.InputMessagesFilterVoice();
    case "url":
      return new Api.InputMessagesFilterUrl();
    case "gif":
      return new Api.InputMessagesFilterGif();
  }
}

const SKIPPED_CLASSES = new Set(["MessageService", "MessageEmpty"]);

export async function fetchSlice(
  client: TelegramLike,
  request: SliceRequest,
): Promise<Slice> {
  const filter = await mediaFilter(request.mediaType);

  const raw = await client.getMessages(request.sourceId, {
    limit: request.limit,
    ...(request.offsetId > 0 ? { offsetId: request.offsetId } : {}),
    // Only on a first page: once a cursor exists, offsetId is the exact
    // resume point and a date offset would fight it.
    ...(request.offsetId === 0 && request.toSeconds !== undefined
      ? { offsetDate: request.toSeconds + 1 }
      : {}),
    ...(filter !== undefined ? { filter } : {}),
  });

  const messages: TelegramMessage[] = [];
  // A short batch means Telegram had nothing more to give.
  let exhausted = raw.length < request.limit;
  let lastId = request.offsetId;

  for (const item of raw) {
    const m = (item ?? {}) as Record<string, unknown>;
    const id = typeof m.id === "number" ? m.id : 0;
    const date = typeof m.date === "number" ? m.date : 0;
    lastId = id;

    const name = typeof m.className === "string" ? m.className : "";
    if (SKIPPED_CLASSES.has(name)) continue;

    // Upper bound: a defensive drop. Telegram's own offset already skipped
    // most of these, but its inclusivity is not worth depending on.
    if (request.toSeconds !== undefined && date > request.toSeconds) continue;

    // History is newest-first, so both of the following are stop conditions,
    // not filters: everything after them is older still.
    if (request.fromSeconds !== undefined && date < request.fromSeconds) {
      exhausted = true;
      break;
    }
    if (
      request.unreadOnly === true &&
      request.readInboxMaxId !== undefined &&
      id <= request.readInboxMaxId
    ) {
      exhausted = true;
      break;
    }

    messages.push(
      mapMessage(item, {
        chatId: request.sourceId,
        ...(request.username !== undefined
          ? { username: request.username }
          : {}),
        ...(request.readInboxMaxId !== undefined
          ? { readInboxMaxId: request.readInboxMaxId }
          : {}),
      }),
    );
  }

  return {
    messages,
    hasMore: !exhausted,
    nextOffsetId: exhausted ? 0 : lastId,
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: PASS, including the pre-existing suites whose fakes gained `getMessages`.

- [ ] **Step 6: Commit**

```bash
git add src/telegram/client.ts src/telegram/message-slice.ts tests/
git commit -m "feat: fetch one source's message slice with date and unread bounds"
```

---

## Task 7: Fan-out, size-cap assembly and `get_messages`

**Files:**
- Create: `src/telegram/messages.ts`
- Test: `tests/telegram-messages.test.ts`

**Interfaces:**
- Consumes: `withTelegram` from `src/telegram/client.ts`; `fetchDialogIndex`, `folderMembers`, `DialogIndex` from `src/telegram/dialog-index.ts`; `fetchSlice`, `MediaType`, `Slice` from `src/telegram/message-slice.ts`; `mapWithConcurrency`, `FANOUT_CONCURRENCY` from `src/concurrency.ts`; `encodeMessageCursor`, `decodeMessageCursor` from `src/pagination.ts`; `fitToSizeCap` from `src/schemas/size.ts`; `GramScopeError` from `src/errors/taxonomy.ts`; `mapTelegramError` from `src/errors/from-telegram.ts`; `TelegramMessage` from `src/schemas/message.ts`.
- Produces:
  - `MAX_SOURCES_PER_CALL = 25`
  - `type GetMessagesInput = { source_ids?: string[]; folder_ids?: string[]; exclude_source_ids?: string[]; from?: string; to?: string; unread_only?: boolean; media_type?: MediaType; limit: number; cursor?: string }`
  - `type SourceBlock = { source_id: string; title: string; messages?: TelegramMessage[]; has_more?: boolean; error?: { code: string; message: string } }`
  - `type GetMessagesResult = { sources: SourceBlock[]; next_cursor?: string }`
  - `parseDateBound(value: string | undefined, field: string): number | undefined`
  - `resolveSourceSet(input: GetMessagesInput, index: DialogIndex): Array<{ sourceId: string; offsetId: number }>`
  - `type Fetched = { source_id: string; title: string; startOffsetId: number; slice?: Slice; error?: { code: string; message: string } }`
  - `renderPage(fetched: Fetched[]): GetMessagesResult`
  - `getMessages(input: GetMessagesInput): Promise<GetMessagesResult>`

- [ ] **Step 1: Write the failing test**

Create `tests/telegram-messages.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import {
  getMessages,
  parseDateBound,
  renderPage,
  resolveSourceSet,
  type Fetched,
} from "@/telegram/messages";
import {
  __resetClientForTests,
  __setClientFactoryForTests,
} from "@/telegram/client";
import { decodeMessageCursor, encodeMessageCursor } from "@/pagination";
import { GramScopeError } from "@/errors/taxonomy";
import { MAX_RESPONSE_BYTES } from "@/schemas/size";

const A = "-100111";
const B = "-100222";
const C = "-100333";

function entry(id: string, title: string) {
  return {
    source_id: id,
    title,
    unread_count: 0,
    read_inbox_max_id: 0,
    folder_ids: [] as string[],
  };
}

const index = {
  byId: new Map([
    [A, entry(A, "Alpha")],
    [B, entry(B, "Beta")],
    [C, entry(C, "Gamma")],
  ]),
  folders: [
    {
      id: "2",
      title: "AI",
      included_peer_ids: [A, B],
      excluded_peer_ids: [],
      order: 0,
    },
  ],
};

function message(id: number, text = "x") {
  return { id, chat_id: A, date: "2025-01-01T00:00:00.000Z", text };
}

function block(
  id: string,
  title: string,
  ids: number[],
  hasMore = false,
): Fetched {
  return {
    source_id: id,
    title,
    startOffsetId: 0,
    slice: {
      messages: ids.map((n) => message(n)),
      hasMore,
      nextOffsetId: hasMore ? ids[ids.length - 1]! : 0,
    },
  };
}

afterEach(() => {
  __setClientFactoryForTests(undefined);
  __resetClientForTests();
});

describe("parseDateBound", () => {
  it("converts ISO 8601 to unix seconds", () => {
    expect(parseDateBound("2025-01-01T00:00:00Z", "from")).toBe(1735689600);
  });

  it("rejects an unparseable date as INVALID_INPUT", () => {
    const error = (() => {
      try {
        parseDateBound("last tuesday", "from");
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect((error as GramScopeError).code).toBe("INVALID_INPUT");
  });
});

describe("resolveSourceSet", () => {
  it("unions explicit sources with folder members and subtracts exclusions", () => {
    const set = resolveSourceSet(
      { source_ids: [C], folder_ids: ["2"], exclude_source_ids: [B], limit: 20 },
      index,
    );
    expect(set.map((s) => s.sourceId)).toEqual([C, A]);
    expect(set.every((s) => s.offsetId === 0)).toBe(true);
  });

  it("de-duplicates a source named twice", () => {
    const set = resolveSourceSet(
      { source_ids: [A], folder_ids: ["2"], limit: 20 },
      index,
    );
    expect(set.map((s) => s.sourceId)).toEqual([A, B]);
  });

  it("rejects an empty selection", () => {
    const error = (() => {
      try {
        resolveSourceSet({ limit: 20 }, index);
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect((error as GramScopeError).code).toBe("INVALID_INPUT");
  });

  it("rejects more than 25 sources by name, never by truncation", () => {
    const many = Array.from({ length: 26 }, (_, i) => `-100${i}`);
    const error = (() => {
      try {
        resolveSourceSet({ source_ids: many, limit: 20 }, index);
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect((error as GramScopeError).code).toBe("INVALID_INPUT");
    expect((error as GramScopeError).message).toContain("26");
  });

  it("takes its source set from the cursor and ignores source_ids", () => {
    const set = resolveSourceSet(
      {
        source_ids: [C],
        limit: 20,
        cursor: encodeMessageCursor({
          sources: [{ sourceId: B, offsetId: 77 }],
        }),
      },
      index,
    );
    expect(set).toEqual([{ sourceId: B, offsetId: 77 }]);
  });
});

describe("renderPage", () => {
  it("groups by source in the requested order", () => {
    const page = renderPage([
      block(A, "Alpha", [3, 2, 1]),
      block(B, "Beta", [9, 8]),
    ]);
    expect(page.sources.map((s) => s.source_id)).toEqual([A, B]);
    expect(page.sources[0]!.messages!.map((m) => m.id)).toEqual([3, 2, 1]);
    expect(page.next_cursor).toBeUndefined();
  });

  it("distinguishes a source that matched nothing from one never reached", () => {
    const page = renderPage([block(A, "Alpha", []), block(B, "Beta", [1])]);
    expect(page.sources[0]!.messages).toEqual([]);
    expect(page.sources[0]!.has_more).toBe(false);
  });

  it("cursors a source that still has history", () => {
    const page = renderPage([block(A, "Alpha", [3, 2], true)]);
    expect(page.sources[0]!.has_more).toBe(true);
    expect(decodeMessageCursor(page.next_cursor!).sources).toEqual([
      { sourceId: A, offsetId: 2 },
    ]);
  });

  it("trims the first oversized source and omits every source after it", () => {
    // One message near the cap, so the second source cannot fit at all.
    const fat = "y".repeat(Math.floor(MAX_RESPONSE_BYTES / 2));
    const fetched: Fetched[] = [
      {
        source_id: A,
        title: "Alpha",
        startOffsetId: 0,
        slice: {
          messages: [
            { id: 3, chat_id: A, date: "2025-01-01T00:00:00.000Z", text: fat },
            { id: 2, chat_id: A, date: "2025-01-01T00:00:00.000Z", text: fat },
            { id: 1, chat_id: A, date: "2025-01-01T00:00:00.000Z", text: fat },
          ],
          hasMore: false,
          nextOffsetId: 0,
        },
      },
      block(B, "Beta", [9, 8]),
    ];

    const page = renderPage(fetched);
    expect(page.sources.map((s) => s.source_id)).toEqual([A]);
    expect(page.sources[0]!.has_more).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(page.sources), "utf8"),
    ).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);

    const resumed = decodeMessageCursor(page.next_cursor!).sources;
    // Alpha resumes after its last served message; Beta resumes where it
    // started, because this page never served any of it.
    expect(resumed).toContainEqual({
      sourceId: A,
      offsetId: page.sources[0]!.messages!.at(-1)!.id,
    });
    expect(resumed).toContainEqual({ sourceId: B, offsetId: 0 });
  });

  it("keeps a failing source visible and out of the cursor", () => {
    const page = renderPage([
      { source_id: A, title: "Alpha", startOffsetId: 0, error: { code: "NOT_A_MEMBER", message: "gone" } },
      block(B, "Beta", [1]),
    ]);
    expect(page.sources[0]).toEqual({
      source_id: A,
      title: "Alpha",
      error: { code: "NOT_A_MEMBER", message: "gone" },
    });
    expect(page.sources[1]!.messages).toHaveLength(1);
    expect(page.next_cursor).toBeUndefined();
  });
});

describe("getMessages", () => {
  const dialogs = [
    {
      id: { value: -100111n },
      title: "Alpha",
      unreadCount: 2,
      entity: { className: "Channel", id: { value: 111n }, username: "alpha" },
      dialog: { readInboxMaxId: 8 },
      message: { id: 10, date: 1735689600 },
    },
    {
      id: { value: -100222n },
      title: "Beta",
      unreadCount: 0,
      entity: { className: "Channel", id: { value: 222n } },
      dialog: { readInboxMaxId: 5 },
      message: { id: 5, date: 1735689600 },
    },
  ];

  function factory(byPeer: Record<string, unknown[]>, fail?: string) {
    return async () => ({
      connected: true,
      connect: async () => true,
      invoke: async () => ({
        filters: [
          {
            id: 2,
            title: "AI",
            includePeers: [
              { channelId: { value: 111n } },
              { channelId: { value: 222n } },
            ],
            excludePeers: [],
          },
        ],
      }),
      getDialogs: async () => dialogs,
      getEntity: async () => ({}),
      getMessages: async (entity: string, params: Record<string, unknown>) => {
        if (entity === fail) throw new Error("CHANNEL_PRIVATE_STUB");
        const limit = typeof params.limit === "number" ? params.limit : 0;
        return (byPeer[entity] ?? []).slice(0, limit);
      },
    });
  }

  const post = (id: number, date = 1735689600) => ({
    className: "Message",
    id,
    date,
    message: `post ${id}`,
  });

  it("fans out over a folder in one call and groups the result", async () => {
    __setClientFactoryForTests(
      factory({
        [A]: [post(10), post(9)],
        [B]: [post(5)],
      }),
    );
    const page = await getMessages({ folder_ids: ["2"], limit: 20 });
    expect(page.sources.map((s) => s.source_id)).toEqual([A, B]);
    expect(page.sources[0]!.title).toBe("Alpha");
    expect(page.sources[0]!.messages!.map((m) => m.id)).toEqual([10, 9]);
    expect(page.sources[0]!.messages![0]!.url).toBe("https://t.me/alpha/10");
  });

  it("applies the read pointer when unread_only is set", async () => {
    __setClientFactoryForTests(
      factory({ [A]: [post(10), post(9), post(8), post(7)] }),
    );
    const page = await getMessages({ source_ids: [A], unread_only: true, limit: 20 });
    expect(page.sources[0]!.messages!.map((m) => m.id)).toEqual([10, 9]);
  });

  it("reads a date window without consulting read state", async () => {
    // The owner's second query shape: a week's history, read or not.
    const week = 7 * 24 * 3600;
    __setClientFactoryForTests(
      factory({
        [A]: [post(10), post(9, 1735689600 - week - 1)],
      }),
    );
    const page = await getMessages({
      source_ids: [A],
      from: new Date((1735689600 - week) * 1000).toISOString(),
      limit: 20,
    });
    expect(page.sources[0]!.messages!.map((m) => m.id)).toEqual([10]);
  });

  it("rejects from after to", async () => {
    __setClientFactoryForTests(factory({}));
    await expect(
      getMessages({
        source_ids: [A],
        from: "2025-02-01T00:00:00Z",
        to: "2025-01-01T00:00:00Z",
        limit: 20,
      }),
    ).rejects.toMatchObject({ code: "INVALID_DATE_RANGE" });
  });

  it("degrades one dead source without failing the page", async () => {
    __setClientFactoryForTests(factory({ [B]: [post(5)] }, A));
    const page = await getMessages({ folder_ids: ["2"], limit: 20 });
    expect(page.sources[0]!.error).toBeTruthy();
    expect(page.sources[0]!.messages).toBeUndefined();
    expect(page.sources[1]!.messages).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/telegram-messages.test.ts`
Expected: FAIL — `Failed to resolve import "@/telegram/messages"`.

- [ ] **Step 3: Write the implementation**

Create `src/telegram/messages.ts`:

```ts
import { withTelegram } from "./client";
import {
  fetchDialogIndex,
  folderMembers,
  type DialogIndex,
} from "./dialog-index";
import { fetchSlice, type MediaType, type Slice } from "./message-slice";
import { FANOUT_CONCURRENCY, mapWithConcurrency } from "../concurrency";
import { decodeMessageCursor, encodeMessageCursor } from "../pagination";
import { fitToSizeCap } from "../schemas/size";
import { GramScopeError } from "../errors/taxonomy";
import { mapTelegramError } from "../errors/from-telegram";
import type { TelegramMessage } from "../schemas/message";

/**
 * Spec §5.1. A fan-out wider than this stops being one tool call and starts
 * being a job: 25 sources at limit 100 already fetches 2500 messages.
 */
export const MAX_SOURCES_PER_CALL = 25;

export type GetMessagesInput = {
  source_ids?: string[];
  folder_ids?: string[];
  exclude_source_ids?: string[];
  from?: string;
  to?: string;
  unread_only?: boolean;
  media_type?: MediaType;
  limit: number;
  cursor?: string;
};

export type SourceBlock = {
  source_id: string;
  title: string;
  messages?: TelegramMessage[];
  has_more?: boolean;
  error?: { code: string; message: string };
};

export type GetMessagesResult = {
  sources: SourceBlock[];
  next_cursor?: string;
};

export function parseDateBound(
  value: string | undefined,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new GramScopeError(
      "INVALID_INPUT",
      `${field} is not an ISO 8601 date`,
    );
  }
  return Math.floor(ms / 1000);
}

/**
 * A cursor carries its own source set, so a continuation never re-derives one
 * from folder membership that may have changed between pages.
 */
export function resolveSourceSet(
  input: GetMessagesInput,
  index: DialogIndex,
): Array<{ sourceId: string; offsetId: number }> {
  if (input.cursor) return decodeMessageCursor(input.cursor).sources;

  const excluded = new Set(input.exclude_source_ids ?? []);
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const id of [
    ...(input.source_ids ?? []),
    ...folderMembers(index.folders, input.folder_ids ?? []),
  ]) {
    if (excluded.has(id) || seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }

  if (ordered.length === 0) {
    throw new GramScopeError(
      "INVALID_INPUT",
      "Name at least one source: pass source_ids, folder_ids, or a cursor from a previous page.",
    );
  }
  if (ordered.length > MAX_SOURCES_PER_CALL) {
    throw new GramScopeError(
      "INVALID_INPUT",
      `This selection resolves to ${ordered.length} sources; the limit is ${MAX_SOURCES_PER_CALL}. Split the call.`,
    );
  }

  return ordered.map((sourceId) => ({ sourceId, offsetId: 0 }));
}

export type Fetched = {
  source_id: string;
  title: string;
  /** Where this page started reading; the resume point if it served nothing. */
  startOffsetId: number;
  slice?: Slice;
  error?: { code: string; message: string };
};

type Unit = { blockIndex: number; message: TelegramMessage };

function compose(fetched: Fetched[], kept: Unit[]): GetMessagesResult {
  const keptCount = new Array<number>(fetched.length).fill(0);
  for (const unit of kept) keptCount[unit.blockIndex]!++;

  const sources: SourceBlock[] = [];
  const unexhausted: Array<{ sourceId: string; offsetId: number }> = [];
  let stopped = false;

  for (let i = 0; i < fetched.length; i++) {
    const block = fetched[i]!;

    // A failing source is always visible and never cursored: retrying it on
    // the next page would only reproduce the failure.
    if (block.error) {
      sources.push({
        source_id: block.source_id,
        title: block.title,
        error: block.error,
      });
      continue;
    }

    if (stopped) {
      unexhausted.push({
        sourceId: block.source_id,
        offsetId: block.startOffsetId,
      });
      continue;
    }

    const all = block.slice?.messages ?? [];
    const n = keptCount[i]!;

    if (n === all.length) {
      sources.push({
        source_id: block.source_id,
        title: block.title,
        messages: all,
        has_more: block.slice?.hasMore ?? false,
      });
      if (block.slice?.hasMore) {
        unexhausted.push({
          sourceId: block.source_id,
          offsetId: block.slice.nextOffsetId,
        });
      }
      continue;
    }

    // The budget ran out inside this block. Nothing after it is served, and
    // a block with zero kept messages is omitted entirely — the caller must
    // be able to tell "nothing new here" from "ask again".
    stopped = true;
    if (n === 0) {
      unexhausted.push({
        sourceId: block.source_id,
        offsetId: block.startOffsetId,
      });
      continue;
    }
    const trimmed = all.slice(0, n);
    sources.push({
      source_id: block.source_id,
      title: block.title,
      messages: trimmed,
      has_more: true,
    });
    unexhausted.push({
      sourceId: block.source_id,
      offsetId: trimmed[trimmed.length - 1]!.id,
    });
  }

  return {
    sources,
    ...(unexhausted.length > 0
      ? { next_cursor: encodeMessageCursor({ sources: unexhausted }) }
      : {}),
  };
}

/**
 * Assembles the page source by source, in the requested order, while it fits
 * the response cap. Flattening to one unit per message means the cap search
 * is the existing fitToSizeCap: leading units in order, at least one kept, so
 * a page always makes progress.
 */
export function renderPage(fetched: Fetched[]): GetMessagesResult {
  const units: Unit[] = fetched.flatMap((block, blockIndex) =>
    (block.slice?.messages ?? []).map((message) => ({ blockIndex, message })),
  );
  const fit = fitToSizeCap(units, (kept) => compose(fetched, kept).sources);
  return compose(fetched, units.slice(0, fit));
}

export async function getMessages(
  input: GetMessagesInput,
): Promise<GetMessagesResult> {
  const fromSeconds = parseDateBound(input.from, "from");
  const toSeconds = parseDateBound(input.to, "to");
  if (
    fromSeconds !== undefined &&
    toSeconds !== undefined &&
    fromSeconds > toSeconds
  ) {
    throw new GramScopeError("INVALID_DATE_RANGE", "from is after to");
  }

  const index = await fetchDialogIndex();
  const targets = resolveSourceSet(input, index);

  const fetched = await withTelegram(async (client) =>
    mapWithConcurrency(targets, FANOUT_CONCURRENCY, async (target) => {
      const entry = index.byId.get(target.sourceId);
      const title = entry?.title ?? target.sourceId;
      try {
        const slice = await fetchSlice(client, {
          sourceId: target.sourceId,
          ...(entry?.username !== undefined
            ? { username: entry.username }
            : {}),
          ...(entry !== undefined
            ? { readInboxMaxId: entry.read_inbox_max_id }
            : {}),
          limit: input.limit,
          offsetId: target.offsetId,
          ...(fromSeconds !== undefined ? { fromSeconds } : {}),
          ...(toSeconds !== undefined ? { toSeconds } : {}),
          ...(input.unread_only === true ? { unreadOnly: true } : {}),
          ...(input.media_type !== undefined
            ? { mediaType: input.media_type }
            : {}),
        });
        return {
          source_id: target.sourceId,
          title,
          startOffsetId: target.offsetId,
          slice,
        } satisfies Fetched;
      } catch (err) {
        // Spec §11: one dead channel must not cost a digest.
        const mapped = mapTelegramError(err);
        return {
          source_id: target.sourceId,
          title,
          startOffsetId: target.offsetId,
          error: { code: mapped.code, message: mapped.message },
        } satisfies Fetched;
      }
    }),
  );

  return renderPage(fetched);
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/telegram-messages.test.ts && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/messages.ts tests/telegram-messages.test.ts
git commit -m "feat: fan out message reads across sources under one size budget"
```

---

## Task 8: `get_message` with surrounding context

**Files:**
- Modify: `src/telegram/messages.ts` (append)
- Test: `tests/telegram-messages.test.ts` (append)

**Interfaces:**
- Consumes: everything Task 7 produced, plus `mapMessage`, `MessageContext` from `src/schemas/message.ts`.
- Produces:
  - `MAX_CONTEXT = 20`
  - `type GetMessageInput = { source_id: string; message_id: number; context_before?: number; context_after?: number }`
  - `type GetMessageResult = { source_id: string; source_title: string; message: TelegramMessage; context_before: TelegramMessage[]; context_after: TelegramMessage[] }`
  - `getMessage(input: GetMessageInput): Promise<GetMessageResult>`

- [ ] **Step 1: Write the failing test**

Append to `tests/telegram-messages.test.ts`:

```ts
describe("getMessage", () => {
  const dialogs = [
    {
      id: { value: -100111n },
      title: "Alpha",
      unreadCount: 0,
      entity: { className: "Channel", id: { value: 111n }, username: "alpha" },
      dialog: { readInboxMaxId: 100 },
      message: { id: 100, date: 1735689600 },
    },
  ];

  const post = (id: number) => ({
    className: "Message",
    id,
    date: 1735689600,
    message: `post ${id}`,
  });

  function factory(handler: (params: Record<string, unknown>) => unknown[]) {
    return async () => ({
      connected: true,
      connect: async () => true,
      invoke: async () => ({ filters: [] }),
      getDialogs: async () => dialogs,
      getEntity: async () => ({}),
      getMessages: async (_entity: string, params: Record<string, unknown>) =>
        handler(params),
    });
  }

  it("returns the target with the source title at the top level", async () => {
    __setClientFactoryForTests(factory((params) => (params.ids ? [post(50)] : [])));
    const result = await getMessage({ source_id: A, message_id: 50 });
    expect(result.source_title).toBe("Alpha");
    expect(result.message.id).toBe(50);
    expect(result.context_before).toEqual([]);
    expect(result.context_after).toEqual([]);
    // The title is not repeated on the message itself.
    expect(JSON.stringify(result.message)).not.toContain("Alpha");
  });

  it("returns context in ascending date order", async () => {
    __setClientFactoryForTests(
      factory((params) => {
        if (params.ids) return [post(50)];
        if (params.addOffset === -2) return [post(52), post(51)];
        return [post(49), post(48)];
      }),
    );
    const result = await getMessage({
      source_id: A,
      message_id: 50,
      context_before: 2,
      context_after: 2,
    });
    expect(result.context_before.map((m) => m.id)).toEqual([48, 49]);
    expect(result.context_after.map((m) => m.id)).toEqual([51, 52]);
  });

  it("treats missing context as a shorter array, not an error", async () => {
    __setClientFactoryForTests(
      factory((params) => (params.ids ? [post(50)] : [])),
    );
    const result = await getMessage({
      source_id: A,
      message_id: 50,
      context_before: 5,
    });
    expect(result.context_before).toEqual([]);
  });

  it("reports an absent target as MESSAGE_NOT_FOUND", async () => {
    __setClientFactoryForTests(factory(() => [undefined as unknown as object]));
    await expect(
      getMessage({ source_id: A, message_id: 999 }),
    ).rejects.toMatchObject({ code: "MESSAGE_NOT_FOUND" });
  });

  it("rejects context bounds outside 0..20", async () => {
    __setClientFactoryForTests(factory(() => []));
    await expect(
      getMessage({ source_id: A, message_id: 1, context_after: 21 }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/telegram-messages.test.ts -t getMessage`
Expected: FAIL — `getMessage is not exported`.

- [ ] **Step 3: Append the implementation to `src/telegram/messages.ts`**

Add `mapMessage` and `MessageContext` to the existing import from `../schemas/message`, then append:

```ts
export const MAX_CONTEXT = 20;

export type GetMessageInput = {
  source_id: string;
  message_id: number;
  context_before?: number;
  context_after?: number;
};

export type GetMessageResult = {
  source_id: string;
  source_title: string;
  message: TelegramMessage;
  context_before: TelegramMessage[];
  context_after: TelegramMessage[];
};

function inBounds(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MAX_CONTEXT;
}

export async function getMessage(
  input: GetMessageInput,
): Promise<GetMessageResult> {
  const before = input.context_before ?? 0;
  const after = input.context_after ?? 0;
  if (!inBounds(before) || !inBounds(after)) {
    throw new GramScopeError(
      "INVALID_INPUT",
      `context_before and context_after must be whole numbers between 0 and ${MAX_CONTEXT}`,
    );
  }

  const index = await fetchDialogIndex();
  const entry = index.byId.get(input.source_id);
  const ctx: MessageContext = {
    chatId: input.source_id,
    ...(entry?.username !== undefined ? { username: entry.username } : {}),
    ...(entry !== undefined ? { readInboxMaxId: entry.read_inbox_max_id } : {}),
  };

  return withTelegram(async (client) => {
    const found = await client.getMessages(input.source_id, {
      ids: [input.message_id],
    });
    const target = (found[0] ?? undefined) as Record<string, unknown> | undefined;
    if (!target || typeof target.id !== "number") {
      throw new GramScopeError(
        "MESSAGE_NOT_FOUND",
        `No message ${input.message_id} in ${input.source_id}`,
      );
    }

    // Telegram returns history newest-first from an offset. Older context is
    // a plain page from the target; newer context is the same page shifted
    // backwards past it, which is what a negative add_offset means.
    const older =
      before > 0
        ? await client.getMessages(input.source_id, {
            limit: before,
            offsetId: input.message_id,
          })
        : [];
    const newer =
      after > 0
        ? await client.getMessages(input.source_id, {
            limit: after,
            offsetId: input.message_id,
            addOffset: -after,
          })
        : [];

    const toAscending = (raw: unknown[]) =>
      raw
        .filter(
          (item): item is Record<string, unknown> =>
            typeof item === "object" &&
            item !== null &&
            typeof (item as Record<string, unknown>).id === "number",
        )
        .map((item) => mapMessage(item, ctx))
        .sort((a, b) => a.id - b.id);

    return {
      source_id: input.source_id,
      source_title: entry?.title ?? input.source_id,
      message: mapMessage(target, ctx),
      context_before: toAscending(older),
      context_after: toAscending(newer),
    };
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/telegram-messages.test.ts && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/messages.ts tests/telegram-messages.test.ts
git commit -m "feat: read one message with surrounding context"
```

---

## Task 9: `get_unread_summary`

**Files:**
- Create: `src/telegram/unread.ts`
- Test: `tests/telegram-unread.test.ts`

**Interfaces:**
- Consumes: `fetchDialogIndex`, `folderMembers`, `DialogIndex` from `src/telegram/dialog-index.ts`; `fitToSizeCap` from `src/schemas/size.ts`.
- Produces:
  - `type UnreadSummaryInput = { group_by?: "source" | "folder"; folder_ids?: string[] }`
  - `type UnreadGroup = { source_id?: string; folder_id?: string; title: string; unread_count: number; read_inbox_max_id?: number; latest_message_id?: number; latest_message_date?: string }`
  - `type UnreadSummaryResult = { groups: UnreadGroup[]; total_unread: number }`
  - `summarize(index: DialogIndex, input: UnreadSummaryInput): UnreadSummaryResult` — pure, so the fan-out-free logic tests without a client
  - `getUnreadSummary(input: UnreadSummaryInput): Promise<UnreadSummaryResult>`

- [ ] **Step 1: Write the failing test**

Create `tests/telegram-unread.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { summarize } from "@/telegram/unread";
import type { DialogIndex } from "@/telegram/dialog-index";
import { GramScopeError } from "@/errors/taxonomy";

const A = "-100111";
const B = "-100222";
const C = "-100333";

const index: DialogIndex = {
  byId: new Map([
    [
      A,
      {
        source_id: A,
        title: "Alpha",
        unread_count: 3,
        read_inbox_max_id: 90,
        latest_message_id: 93,
        latest_message_date: "2025-01-01T00:00:00.000Z",
        folder_ids: ["2"],
      },
    ],
    [
      B,
      {
        source_id: B,
        title: "Beta",
        unread_count: 12,
        read_inbox_max_id: 40,
        folder_ids: ["2"],
      },
    ],
    [
      C,
      {
        source_id: C,
        title: "Gamma",
        unread_count: 0,
        read_inbox_max_id: 7,
        folder_ids: ["3"],
      },
    ],
  ]),
  folders: [
    { id: "2", title: "AI", included_peer_ids: [A, B], excluded_peer_ids: [], order: 0 },
    { id: "3", title: "News", included_peer_ids: [C], excluded_peer_ids: [], order: 1 },
  ],
};

describe("summarize by source", () => {
  it("returns only sources with unread, busiest first", () => {
    const result = summarize(index, {});
    expect(result.groups.map((g) => g.source_id)).toEqual([B, A]);
    expect(result.total_unread).toBe(15);
  });

  it("carries the read pointer and latest message", () => {
    const [, alpha] = summarize(index, {}).groups;
    expect(alpha).toMatchObject({
      source_id: A,
      title: "Alpha",
      unread_count: 3,
      read_inbox_max_id: 90,
      latest_message_id: 93,
      latest_message_date: "2025-01-01T00:00:00.000Z",
    });
  });

  it("narrows to the given folders", () => {
    const result = summarize(index, { folder_ids: ["3"] });
    expect(result.groups).toEqual([]);
    expect(result.total_unread).toBe(0);
  });

  it("never returns the oldest-unread date", () => {
    // Deliberately absent: it costs one request per source, and
    // get_messages(unread_only, limit 1) already answers it.
    expect(JSON.stringify(summarize(index, {}))).not.toContain("oldest");
  });
});

describe("summarize by folder", () => {
  it("sums each folder's members and omits the per-folder pointer", () => {
    const result = summarize(index, { group_by: "folder" });
    expect(result.groups).toEqual([
      { folder_id: "2", title: "AI", unread_count: 15 },
    ]);
    expect(result.total_unread).toBe(15);
  });

  it("rejects an unknown folder id", () => {
    const error = (() => {
      try {
        summarize(index, { group_by: "folder", folder_ids: ["99"] });
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(GramScopeError);
    expect((error as GramScopeError).code).toBe("INVALID_INPUT");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/telegram-unread.test.ts`
Expected: FAIL — `Failed to resolve import "@/telegram/unread"`.

- [ ] **Step 3: Write the implementation**

Create `src/telegram/unread.ts`:

```ts
import {
  fetchDialogIndex,
  folderMembers,
  type DialogIndex,
} from "./dialog-index";
import { fitToSizeCap } from "../schemas/size";

export type UnreadSummaryInput = {
  group_by?: "source" | "folder";
  folder_ids?: string[];
};

export type UnreadGroup = {
  source_id?: string;
  folder_id?: string;
  title: string;
  unread_count: number;
  read_inbox_max_id?: number;
  latest_message_id?: number;
  latest_message_date?: string;
};

export type UnreadSummaryResult = {
  groups: UnreadGroup[];
  total_unread: number;
};

/**
 * Everything here comes off the dialog list the index already holds:
 * unread_count, the read pointer and the top message are all fields Telegram
 * puts on a Dialog. The summary therefore costs zero extra round trips.
 *
 * total_unread counts every group in scope, including any the size cap
 * trimmed off the end of `groups`.
 */
export function summarize(
  index: DialogIndex,
  input: UnreadSummaryInput,
): UnreadSummaryResult {
  const scoped = input.folder_ids?.length
    ? new Set(folderMembers(index.folders, input.folder_ids))
    : undefined;

  if ((input.group_by ?? "source") === "folder") {
    const wanted = input.folder_ids?.length
      ? index.folders.filter((f) => input.folder_ids!.includes(f.id))
      : index.folders;

    const groups: UnreadGroup[] = wanted
      .map((folder) => {
        const excluded = new Set(folder.excluded_peer_ids);
        const unread = folder.included_peer_ids
          .filter((id) => !excluded.has(id))
          .reduce(
            (sum, id) => sum + (index.byId.get(id)?.unread_count ?? 0),
            0,
          );
        return {
          folder_id: folder.id,
          title: folder.title,
          unread_count: unread,
        };
      })
      .filter((group) => group.unread_count > 0)
      .sort((a, b) => b.unread_count - a.unread_count);

    return {
      groups,
      total_unread: groups.reduce((sum, g) => sum + g.unread_count, 0),
    };
  }

  const entries = [...index.byId.values()]
    .filter(
      (entry) =>
        entry.unread_count > 0 && (!scoped || scoped.has(entry.source_id)),
    )
    .sort((a, b) => b.unread_count - a.unread_count);

  const total = entries.reduce((sum, entry) => sum + entry.unread_count, 0);

  const groups: UnreadGroup[] = entries.map((entry) => ({
    source_id: entry.source_id,
    title: entry.title,
    unread_count: entry.unread_count,
    read_inbox_max_id: entry.read_inbox_max_id,
    ...(entry.latest_message_id !== undefined
      ? { latest_message_id: entry.latest_message_id }
      : {}),
    ...(entry.latest_message_date !== undefined
      ? { latest_message_date: entry.latest_message_date }
      : {}),
  }));

  const fit = fitToSizeCap(groups, (kept) => ({
    groups: kept,
    total_unread: total,
  }));

  return { groups: groups.slice(0, fit), total_unread: total };
}

export async function getUnreadSummary(
  input: UnreadSummaryInput,
): Promise<UnreadSummaryResult> {
  return summarize(await fetchDialogIndex(), input);
}
```

Note: `folderMembers` is called for its validation side effect in folder mode too — call `folderMembers(index.folders, input.folder_ids ?? [])` at the top of the function (the `scoped` line already does this whenever `folder_ids` is non-empty), so an unknown id fails in both modes.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/telegram-unread.test.ts && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/unread.ts tests/telegram-unread.test.ts
git commit -m "feat: summarize unread state per source or per folder"
```

---

## Task 10: `mark_read` — the one mutating path

Read the ledger note from Task 1 before starting. If Task 1's probe failed, resolve peers from `client.getDialogs()` results instead of `client.getEntity`, and say so in the commit message.

**Files:**
- Create: `src/telegram/read-state.ts`
- Test: `tests/telegram-read-state.test.ts`

**Interfaces:**
- Consumes: `getApi`, `withTelegram` from `src/telegram/client.ts`; `fetchDialogIndex` from `src/telegram/dialog-index.ts`; `mapWithConcurrency`, `FANOUT_CONCURRENCY` from `src/concurrency.ts`; `GramScopeError` from `src/errors/taxonomy.ts`; `mapTelegramError` from `src/errors/from-telegram.ts`.
- Produces:
  - `MAX_MARK_READ_SOURCES = 25`
  - `type MarkReadInput = { source_ids: string[]; up_to_message_id?: number }`
  - `type MarkReadResult = { results: Array<{ source_id: string; read_inbox_max_id: number }>; failures: Array<{ source_id: string; code: string; message: string }> }`
  - `markRead(input: MarkReadInput): Promise<MarkReadResult>`

- [ ] **Step 1: Write the failing test**

Create `tests/telegram-read-state.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { markRead } from "@/telegram/read-state";
import {
  __resetClientForTests,
  __setClientFactoryForTests,
} from "@/telegram/client";

const CHANNEL = "-100111";
const CHAT = "-222";

const dialogs = [
  {
    id: { value: -100111n },
    title: "Alpha",
    unreadCount: 4,
    entity: { className: "Channel", id: { value: 111n } },
    dialog: { readInboxMaxId: 96 },
    message: { id: 100, date: 1735689600 },
  },
  {
    id: { value: -222n },
    title: "Legacy",
    unreadCount: 1,
    entity: { className: "Chat", id: { value: 222n } },
    dialog: { readInboxMaxId: 9 },
    message: { id: 10, date: 1735689600 },
  },
];

function factory(options: {
  sent: unknown[];
  entities?: Record<string, Record<string, unknown>>;
  failOn?: string;
}) {
  return async () => ({
    connected: true,
    connect: async () => true,
    invoke: async (request: unknown) => {
      options.sent.push(request);
      return true;
    },
    getDialogs: async () => dialogs,
    getEntity: async (id: string) => {
      if (id === options.failOn) throw new Error("CHANNEL_PRIVATE");
      return (
        options.entities?.[id] ?? { className: "Channel", id: { value: 111n } }
      );
    },
    getMessages: async () => [],
  });
}

afterEach(() => {
  __setClientFactoryForTests(undefined);
  __resetClientForTests();
});

describe("markRead", () => {
  it("advances a channel to an explicit message id", async () => {
    const sent: unknown[] = [];
    __setClientFactoryForTests(factory({ sent }));
    const result = await markRead({
      source_ids: [CHANNEL],
      up_to_message_id: 98,
    });
    expect(result.results).toEqual([
      { source_id: CHANNEL, read_inbox_max_id: 98 },
    ]);
    expect(result.failures).toEqual([]);
    expect((sent[0] as { className?: string }).className).toBe(
      "channels.ReadHistory",
    );
    expect((sent[0] as { maxId?: number }).maxId).toBe(98);
  });

  it("defaults to the source's latest message", async () => {
    const sent: unknown[] = [];
    __setClientFactoryForTests(factory({ sent }));
    const result = await markRead({ source_ids: [CHANNEL] });
    expect(result.results[0]!.read_inbox_max_id).toBe(100);
  });

  it("uses messages.readHistory for a legacy chat", async () => {
    const sent: unknown[] = [];
    __setClientFactoryForTests(
      factory({
        sent,
        entities: { [CHAT]: { className: "Chat", id: { value: 222n } } },
      }),
    );
    await markRead({ source_ids: [CHAT] });
    expect((sent[0] as { className?: string }).className).toBe(
      "messages.ReadHistory",
    );
  });

  it("reports a per-source failure without failing the call", async () => {
    const sent: unknown[] = [];
    __setClientFactoryForTests(factory({ sent, failOn: CHANNEL }));
    const result = await markRead({ source_ids: [CHANNEL, CHAT] });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      source_id: CHANNEL,
      code: "PRIVATE_CHANNEL_NOT_ACCESSIBLE",
    });
    expect(result.results).toHaveLength(1);
  });

  it("always returns both arrays", async () => {
    __setClientFactoryForTests(factory({ sent: [] }));
    const result = await markRead({ source_ids: [CHANNEL] });
    expect(Array.isArray(result.results)).toBe(true);
    expect(Array.isArray(result.failures)).toBe(true);
  });

  it("rejects an empty or oversized selection", async () => {
    __setClientFactoryForTests(factory({ sent: [] }));
    await expect(markRead({ source_ids: [] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(
      markRead({
        source_ids: Array.from({ length: 26 }, (_, i) => `-100${i}`),
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
```

The `PRIVATE_CHANNEL_NOT_ACCESSIBLE` expectation relies on `mapTelegramError` reading `errorMessage`. Use `Object.assign(new Error("private"), { errorMessage: "CHANNEL_PRIVATE" })` in the fake's `getEntity` throw so the mapping is exercised as it is in production.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/telegram-read-state.test.ts`
Expected: FAIL — `Failed to resolve import "@/telegram/read-state"`.

- [ ] **Step 3: Write the implementation**

Create `src/telegram/read-state.ts`:

```ts
import { getApi, withTelegram } from "./client";
import { fetchDialogIndex } from "./dialog-index";
import { FANOUT_CONCURRENCY, mapWithConcurrency } from "../concurrency";
import { GramScopeError } from "../errors/taxonomy";
import { mapTelegramError } from "../errors/from-telegram";

export const MAX_MARK_READ_SOURCES = 25;

export type MarkReadInput = {
  source_ids: string[];
  up_to_message_id?: number;
};

export type MarkReadSuccess = {
  source_id: string;
  read_inbox_max_id: number;
};

export type MarkReadFailure = {
  source_id: string;
  code: string;
  message: string;
};

export type MarkReadResult = {
  results: MarkReadSuccess[];
  failures: MarkReadFailure[];
};

/**
 * The only mutating path in this sub-project, kept in its own file so it can
 * be reviewed on its own.
 *
 * Peers resolve exactly as reads do: teleproto's getInputEntity falls through
 * to channels.getChannels with access_hash = 0, which Telegram accepts for
 * channels the account holds. Spec §10; Task 1 of the plan verified it live.
 */
export async function markRead(
  input: MarkReadInput,
): Promise<MarkReadResult> {
  if (input.source_ids.length === 0) {
    throw new GramScopeError(
      "INVALID_INPUT",
      "source_ids must name at least one source",
    );
  }
  if (input.source_ids.length > MAX_MARK_READ_SOURCES) {
    throw new GramScopeError(
      "INVALID_INPUT",
      `mark_read accepts at most ${MAX_MARK_READ_SOURCES} sources per call; got ${input.source_ids.length}. Split the call.`,
    );
  }

  const index = await fetchDialogIndex();

  const outcomes = await withTelegram(async (client) => {
    const Api = await getApi();
    return mapWithConcurrency(
      input.source_ids,
      FANOUT_CONCURRENCY,
      async (sourceId): Promise<MarkReadSuccess | MarkReadFailure> => {
        try {
          const maxId =
            input.up_to_message_id ??
            index.byId.get(sourceId)?.latest_message_id;
          if (maxId === undefined) {
            throw new GramScopeError(
              "CHANNEL_NOT_FOUND",
              `No dialog for ${sourceId}; pass up_to_message_id explicitly.`,
            );
          }

          const entity = await client.getEntity(sourceId);
          const request =
            entity.className === "Channel"
              ? new Api.channels.ReadHistory({
                  channel: entity as never,
                  maxId,
                })
              : new Api.messages.ReadHistory({ peer: entity as never, maxId });
          await client.invoke(request);

          return { source_id: sourceId, read_inbox_max_id: maxId };
        } catch (err) {
          // Spec §5.4: one inaccessible channel must not cost the caller the
          // other twenty-four.
          const mapped = mapTelegramError(err);
          return {
            source_id: sourceId,
            code: mapped.code,
            message: mapped.message,
          };
        }
      },
    );
  });

  return {
    results: outcomes.filter(
      (outcome): outcome is MarkReadSuccess =>
        "read_inbox_max_id" in outcome,
    ),
    failures: outcomes.filter(
      (outcome): outcome is MarkReadFailure => "code" in outcome,
    ),
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/telegram-read-state.test.ts && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/read-state.ts tests/telegram-read-state.test.ts
git commit -m "feat: advance the Telegram read pointer with per-source failure isolation"
```

---

## Task 11: Register the four MCP tools

**Files:**
- Create: `src/mcp/tools/get-messages.ts`, `src/mcp/tools/get-message.ts`, `src/mcp/tools/get-unread-summary.ts`, `src/mcp/tools/mark-read.ts`
- Modify: `src/mcp/server.ts`, `src/mcp/tool-result.ts`, `app/api/mcp/route.ts`, `tests/tools.test.ts`

**Interfaces:**
- Consumes: `getMessages`, `getMessage`, `MAX_SOURCES_PER_CALL`, `MAX_CONTEXT` from `src/telegram/messages.ts`; `getUnreadSummary` from `src/telegram/unread.ts`; `markRead`, `MAX_MARK_READ_SOURCES` from `src/telegram/read-state.ts`; `MEDIA_TYPES` from `src/telegram/message-slice.ts`; `telegramMessageSchema` from `src/schemas/message.ts`; `runTool` from `src/mcp/tool-result.ts`.
- Produces: `registerGetMessages`, `registerGetMessage`, `registerGetUnreadSummary`, `registerMarkRead`, each `(server: McpServer): void`.

- [ ] **Step 1: Write the failing test**

Replace the `registerTools` block in `tests/tools.test.ts`:

```ts
describe("registerTools", () => {
  function fakeServer() {
    const tools: Array<{ name: string; config: Record<string, unknown> }> = [];
    return {
      tools,
      registerTool(name: string, config: Record<string, unknown>) {
        tools.push({ name, config });
      },
    };
  }

  const READ_ONLY = [
    "get_channel",
    "get_message",
    "get_messages",
    "get_unread_summary",
    "list_dialogs",
    "list_folders",
  ];

  it("registers all seven tools", () => {
    const server = fakeServer();
    registerTools(server as never);
    expect(server.tools.map((t) => t.name).sort()).toEqual(
      [...READ_ONLY, "mark_read"].sort(),
    );
  });

  it("derives readOnlyHint from behaviour, not uniformly", () => {
    // The card's carried-forward decision: mark_read mutates account state,
    // and a client that trusts a uniform `true` would call it freely.
    const server = fakeServer();
    registerTools(server as never);
    for (const tool of server.tools) {
      expect(tool.config.annotations).toMatchObject({
        readOnlyHint: tool.name !== "mark_read",
      });
    }
  });

  it("says plainly in mark_read's description that it mutates state", () => {
    const server = fakeServer();
    registerTools(server as never);
    const markRead = server.tools.find((t) => t.name === "mark_read")!;
    expect(String(markRead.config.description).toLowerCase()).toContain(
      "changes account state",
    );
  });
});
```

Add to the same file:

```ts
import { runTool } from "@/mcp/tool-result";

describe("countOf", () => {
  it("counts messages across a grouped response, not source blocks", async () => {
    const lines: string[] = [];
    await runTool(
      "get_messages",
      async () => ({
        sources: [
          { source_id: "-1001", title: "A", messages: [{}, {}], has_more: false },
          { source_id: "-1002", title: "B", messages: [{}], has_more: false },
        ],
      }),
      (line) => lines.push(line),
    );
    expect(lines.join("")).toContain('"count":3');
  });

  it("falls back to the array length for a flat response", async () => {
    const lines: string[] = [];
    await runTool(
      "list_folders",
      async () => ({ folders: [{}, {}] }),
      (line) => lines.push(line),
    );
    expect(lines.join("")).toContain('"count":2');
  });
});
```

Check `src/mcp/logging.ts` for the exact log line format before asserting on `"count":3`; match whatever `logToolCall` actually emits.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tools.test.ts`
Expected: FAIL — three tools registered, not seven.

- [ ] **Step 3: Write `src/mcp/tools/get-messages.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { getMessages, MAX_SOURCES_PER_CALL } from "../../telegram/messages";
import { MEDIA_TYPES } from "../../telegram/message-slice";
import { telegramMessageSchema } from "../../schemas/message";
import { runTool } from "../tool-result";

export const sourceBlockSchema = z.object({
  source_id: z.string(),
  title: z.string(),
  messages: z.array(telegramMessageSchema).optional(),
  has_more: z.boolean().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});

export function registerGetMessages(server: McpServer): void {
  server.registerTool(
    "get_messages",
    {
      title: "Read Telegram message history",
      description:
        "Read recent messages from one or many Telegram sources in a single call. Sources are named by source_ids, by folder_ids (expanded to their member channels), or both, minus exclude_source_ids; the effective set is capped at " +
        `${MAX_SOURCES_PER_CALL} sources. Results are grouped by source, newest first within each source, and limit applies PER SOURCE. Date filtering with from/to is independent of read state, so a date-windowed read returns messages whether or not they have been read. A source that was reached but matched nothing has an empty messages array; a source this page never reached is absent from the response and named in next_cursor. To continue, resend every filter unchanged together with next_cursor — the cursor supplies its own source set, so source_ids, folder_ids and exclude_source_ids are ignored when it is present. Read-only: this does not mark anything as read.`,
      inputSchema: z.object({
        source_ids: z
          .array(z.string())
          .optional()
          .describe("Marked source ids as returned by list_dialogs."),
        folder_ids: z
          .array(z.string())
          .optional()
          .describe(
            "Folder ids from list_folders, expanded to their member sources.",
          ),
        exclude_source_ids: z
          .array(z.string())
          .optional()
          .describe("Subtracted from the union of source_ids and folder_ids."),
        from: z
          .string()
          .optional()
          .describe("ISO 8601. Inclusive lower bound on message date."),
        to: z
          .string()
          .optional()
          .describe("ISO 8601. Inclusive upper bound on message date."),
        unread_only: z
          .boolean()
          .optional()
          .describe("Return only messages above each source's read pointer."),
        media_type: z.enum(MEDIA_TYPES).optional(),
        limit: z.number().int().min(1).max(100).default(20),
        cursor: z.string().optional(),
      }),
      outputSchema: z.object({
        sources: z.array(sourceBlockSchema),
        next_cursor: z.string().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (input) => runTool("get_messages", () => getMessages(input)),
  );
}
```

- [ ] **Step 4: Write `src/mcp/tools/get-message.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { getMessage, MAX_CONTEXT } from "../../telegram/messages";
import { telegramMessageSchema } from "../../schemas/message";
import { runTool } from "../tool-result";

export function registerGetMessage(server: McpServer): void {
  server.registerTool(
    "get_message",
    {
      title: "Read one Telegram message",
      description:
        "Read a single message by source id and message id, optionally with the messages immediately before and after it. Context arrays are in ascending date order; missing context is a shorter array, not an error. Read-only.",
      inputSchema: z.object({
        source_id: z.string(),
        message_id: z.number().int(),
        context_before: z
          .number()
          .int()
          .min(0)
          .max(MAX_CONTEXT)
          .default(0)
          .describe("How many older messages to include."),
        context_after: z
          .number()
          .int()
          .min(0)
          .max(MAX_CONTEXT)
          .default(0)
          .describe("How many newer messages to include."),
      }),
      outputSchema: z.object({
        source_id: z.string(),
        source_title: z.string(),
        message: telegramMessageSchema,
        context_before: z.array(telegramMessageSchema),
        context_after: z.array(telegramMessageSchema),
      }),
      annotations: { readOnlyHint: true },
    },
    async (input) => runTool("get_message", () => getMessage(input)),
  );
}
```

- [ ] **Step 5: Write `src/mcp/tools/get-unread-summary.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { getUnreadSummary } from "../../telegram/unread";
import { runTool } from "../tool-result";

export function registerGetUnreadSummary(server: McpServer): void {
  server.registerTool(
    "get_unread_summary",
    {
      title: "Summarize unread Telegram messages",
      description:
        "Report how many unread messages each source, or each folder, is holding. Only sources or folders with unread messages are returned, busiest first. The oldest unread message's date is not reported; get_messages with unread_only and limit 1 answers that for one source. Read-only.",
      inputSchema: z.object({
        group_by: z.enum(["source", "folder"]).default("source"),
        folder_ids: z
          .array(z.string())
          .optional()
          .describe("Narrow the report to these folders."),
      }),
      outputSchema: z.object({
        groups: z.array(
          z.object({
            source_id: z.string().optional(),
            folder_id: z.string().optional(),
            title: z.string(),
            unread_count: z.number().int(),
            read_inbox_max_id: z.number().int().optional(),
            latest_message_id: z.number().int().optional(),
            latest_message_date: z.string().optional(),
          }),
        ),
        total_unread: z.number().int(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      runTool("get_unread_summary", () => getUnreadSummary(input)),
  );
}
```

- [ ] **Step 6: Write `src/mcp/tools/mark-read.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { markRead, MAX_MARK_READ_SOURCES } from "../../telegram/read-state";
import { runTool } from "../tool-result";

export function registerMarkRead(server: McpServer): void {
  server.registerTool(
    "mark_read",
    {
      title: "Mark Telegram sources as read",
      description:
        "Advance the read pointer on up to " +
        `${MAX_MARK_READ_SOURCES} sources, so the next unread sweep does not return the same messages. This CHANGES ACCOUNT STATE and is visible in every Telegram client on the account; reading never does. Without up_to_message_id each source is marked read through its latest message. A source that cannot be reached is reported in failures and does not fail the call.`,
      inputSchema: z.object({
        source_ids: z.array(z.string()).min(1).max(MAX_MARK_READ_SOURCES),
        up_to_message_id: z
          .number()
          .int()
          .optional()
          .describe(
            "Mark read through this message id. Omit to use each source's latest message.",
          ),
      }),
      outputSchema: z.object({
        results: z.array(
          z.object({
            source_id: z.string(),
            read_inbox_max_id: z.number().int(),
          }),
        ),
        failures: z.array(
          z.object({
            source_id: z.string(),
            code: z.string(),
            message: z.string(),
          }),
        ),
      }),
      annotations: { readOnlyHint: false },
    },
    async (input) => runTool("mark_read", () => markRead(input)),
  );
}
```

- [ ] **Step 7: Wire them into `src/mcp/server.ts`**

```ts
import type { McpServer } from "@modelcontextprotocol/server";
import { registerGetChannel } from "./tools/get-channel";
import { registerGetMessage } from "./tools/get-message";
import { registerGetMessages } from "./tools/get-messages";
import { registerGetUnreadSummary } from "./tools/get-unread-summary";
import { registerListDialogs } from "./tools/list-dialogs";
import { registerListFolders } from "./tools/list-folders";
import { registerMarkRead } from "./tools/mark-read";

export function registerTools(server: McpServer): void {
  registerListDialogs(server);
  registerListFolders(server);
  registerGetChannel(server);
  registerGetMessages(server);
  registerGetMessage(server);
  registerGetUnreadSummary(server);
  registerMarkRead(server);
}
```

- [ ] **Step 8: Teach `countOf` the grouped shape**

In `src/mcp/tool-result.ts`, replace `countOf`:

```ts
function messageCount(items: unknown[]): number | undefined {
  let total: number | undefined;
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const messages = (item as Record<string, unknown>).messages;
    if (Array.isArray(messages)) total = (total ?? 0) + messages.length;
  }
  return total;
}

/**
 * The log line reports how much a call actually returned. For the grouped
 * multi-source shape that is the message count, not the number of source
 * blocks — three blocks holding sixty messages is not "3".
 */
function countOf(data: unknown): number | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  for (const key of ["sources", "folders", "groups", "results"]) {
    const value = (data as Record<string, unknown>)[key];
    if (!Array.isArray(value)) continue;
    return messageCount(value) ?? value.length;
  }
  return undefined;
}
```

- [ ] **Step 9: Raise the function budget in `app/api/mcp/route.ts`**

Add near the top of the file, after the imports:

```ts
/**
 * Spec §7: a 25-source fan-out at 8-way concurrency is four sequential rounds
 * of MTProto round trips. Vercel's 10-15s default would cut a wide digest off
 * mid-flight and report it as a server error.
 */
export const maxDuration = 60;
```

- [ ] **Step 10: Run the tests**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/mcp app/api/mcp/route.ts tests/tools.test.ts
git commit -m "feat: expose get_messages, get_message, get_unread_summary and mark_read"
```

---

## Task 12: `tools/list` through a real MCP server

This closes the review finding carried on the card since sub-project 1: a tool dropped from `registerTools`, or given an `inputSchema` the SDK cannot convert to JSON Schema, currently ships silently and presents to the owner as "connector connected, no tools available". `tests/tools.test.ts` uses a hand-rolled fake server and cannot catch either.

**Files:**
- Create: `tests/mcp-handler.test.ts`

**Interfaces:**
- Consumes: `McpServer`, `InMemoryTransport` from `@modelcontextprotocol/server`; `registerTools` from `src/mcp/server.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/mcp-handler.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { registerTools } from "@/mcp/server";

type Json = Record<string, unknown>;

/**
 * Drives a real McpServer over the SDK's in-memory transport and speaks raw
 * JSON-RPC on the other end. The hand-rolled fake in tools.test.ts asserts
 * that registerTools was called; this asserts that what it registered
 * survives the SDK's own schema conversion, which is where a bad inputSchema
 * actually fails.
 */
async function listTools(): Promise<Json[]> {
  const server = new McpServer({ name: "gramscope", version: "test" });
  registerTools(server);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const inbox: Json[] = [];
  clientTransport.onmessage = (message) => inbox.push(message as Json);
  await clientTransport.start();

  const waitFor = async (id: number): Promise<Json> => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const found = inbox.find((m) => m.id === id);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`no response to request ${id}`);
  };

  await clientTransport.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    },
  } as never);
  await waitFor(1);

  await clientTransport.send({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  } as never);

  await clientTransport.send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  } as never);
  const response = await waitFor(2);

  await server.close();
  return ((response.result as Json).tools ?? []) as Json[];
}

describe("tools/list over a real MCP server", () => {
  it("advertises all seven tools", async () => {
    const tools = await listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_channel",
      "get_message",
      "get_messages",
      "get_unread_summary",
      "list_dialogs",
      "list_folders",
      "mark_read",
    ]);
  });

  it("gives every tool a usable object input schema", async () => {
    const tools = await listTools();
    for (const tool of tools) {
      const schema = tool.inputSchema as Json | undefined;
      expect(schema, `${String(tool.name)} has no inputSchema`).toBeTruthy();
      expect(schema!.type).toBe("object");
      expect(typeof tool.description).toBe("string");
      expect(String(tool.description).length).toBeGreaterThan(40);
    }
  });

  it("marks only mark_read as mutating", async () => {
    const tools = await listTools();
    for (const tool of tools) {
      const annotations = (tool.annotations ?? {}) as Json;
      expect(annotations.readOnlyHint, String(tool.name)).toBe(
        tool.name !== "mark_read",
      );
    }
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/mcp-handler.test.ts`
Expected: PASS if Task 11 is correct. If the transport handshake needs a different protocol version string, read the value the server returns in the `initialize` response and use it; do not weaken the assertions to make the test pass.

- [ ] **Step 3: Prove the test catches a regression**

Temporarily comment out `registerMarkRead(server);` in `src/mcp/server.ts`, run `npx vitest run tests/mcp-handler.test.ts`, confirm it FAILS, then restore the line. A registration test that cannot fail is worse than none.

- [ ] **Step 4: Run the full suite**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/mcp-handler.test.ts
git commit -m "test: assert tools/list through a real MCP server"
```

---

## Task 13: Live suite against the real account

**Files:**
- Create: `tests/live/reading.live.test.ts`

**Interfaces:**
- Consumes: `getMessages`, `getMessage` from `src/telegram/messages.ts`; `getUnreadSummary` from `src/telegram/unread.ts`; `markRead` from `src/telegram/read-state.ts`; `fetchFolders` from `src/telegram/folders.ts`; `MAX_RESPONSE_BYTES` from `src/schemas/size.ts`.

House rule inherited from `tests/live/foundation.live.test.ts`: an assertion inside a loop over a fetched list proves nothing when the list is empty. Every loop is preceded by an assertion, or a visible `ctx.skip()`, on the length of what it iterates.

- [ ] **Step 1: Write the live suite**

Create `tests/live/reading.live.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { getMessage, getMessages } from "@/telegram/messages";
import { getUnreadSummary } from "@/telegram/unread";
import { markRead } from "@/telegram/read-state";
import { fetchFolders } from "@/telegram/folders";
import { MAX_RESPONSE_BYTES } from "@/schemas/size";

const enabled = process.env.GRAMSCOPE_LIVE === "1";
const suite = enabled ? describe : describe.skip;

async function populatedFolder() {
  const folders = await fetchFolders();
  const folder = folders.find((f) => f.included_peer_ids.length > 1);
  if (!folder) {
    throw new Error(
      "the live suite needs a folder with at least two members; add one before running it",
    );
  }
  return folder;
}

suite("Reading against the real account", () => {
  beforeAll(() => {
    if (!process.env.TELEGRAM_SESSION) {
      throw new Error("TELEGRAM_SESSION is required for live tests");
    }
  });

  it("fans out over a real folder in one call", async () => {
    const folder = await populatedFolder();
    const page = await getMessages({ folder_ids: [folder.id], limit: 5 });

    expect(page.sources.length).toBeGreaterThan(1);
    const withMessages = page.sources.filter(
      (s) => (s.messages?.length ?? 0) > 0,
    );
    expect(
      withMessages.length,
      "every source in the folder came back empty; the fan-out is not reading",
    ).toBeGreaterThan(0);

    for (const source of withMessages) {
      expect(source.title).toBeTruthy();
      expect(source.messages![0]!.chat_id).toBe(source.source_id);
      // Newest first, per spec §7.
      const ids = source.messages!.map((m) => m.id);
      expect([...ids].sort((a, b) => b - a)).toEqual(ids);
    }
  });

  it("keeps a wide page under the size cap", async () => {
    const folder = await populatedFolder();
    const page = await getMessages({ folder_ids: [folder.id], limit: 100 });
    expect(
      Buffer.byteLength(JSON.stringify(page), "utf8"),
    ).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
  });

  it("reads a date window regardless of read state", async () => {
    const folder = await populatedFolder();
    const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const page = await getMessages({
      folder_ids: [folder.id],
      from: weekAgo,
      limit: 20,
    });

    const messages = page.sources.flatMap((s) => s.messages ?? []);
    expect(
      messages.length,
      "no messages in the past week; pick a busier folder for the live suite",
    ).toBeGreaterThan(0);
    for (const message of messages) {
      expect(Date.parse(message.date)).toBeGreaterThanOrEqual(
        Date.parse(weekAgo),
      );
    }
    // The window must not be silently filtered by read state.
    expect(messages.some((m) => m.is_read === true)).toBe(true);
  });

  it("walks two disjoint pages", async (ctx) => {
    const folder = await populatedFolder();
    const first = await getMessages({ folder_ids: [folder.id], limit: 2 });
    if (!first.next_cursor) {
      ctx.skip();
      return;
    }
    const second = await getMessages({
      folder_ids: [folder.id],
      limit: 2,
      cursor: first.next_cursor,
    });

    const firstKeys = new Set(
      first.sources.flatMap((s) =>
        (s.messages ?? []).map((m) => `${s.source_id}:${m.id}`),
      ),
    );
    const secondKeys = second.sources.flatMap((s) =>
      (s.messages ?? []).map((m) => `${s.source_id}:${m.id}`),
    );
    expect(
      secondKeys.length,
      "a next_cursor was issued but the page it resumes is empty",
    ).toBeGreaterThan(0);
    for (const key of secondKeys) expect(firstKeys.has(key)).toBe(false);
  });

  it("reads one message with surrounding context", async () => {
    const folder = await populatedFolder();
    const page = await getMessages({ folder_ids: [folder.id], limit: 5 });
    const source = page.sources.find((s) => (s.messages?.length ?? 0) > 2);
    expect(
      source,
      "no source returned three messages; pick a busier folder",
    ).toBeTruthy();

    const target = source!.messages![1]!;
    const detail = await getMessage({
      source_id: source!.source_id,
      message_id: target.id,
      context_before: 2,
      context_after: 1,
    });
    expect(detail.message.id).toBe(target.id);
    expect(detail.source_title).toBe(source!.title);
    expect(detail.context_before.length).toBeGreaterThan(0);
    const before = detail.context_before.map((m) => m.id);
    expect([...before].sort((a, b) => a - b)).toEqual(before);
    for (const message of detail.context_before) {
      expect(message.id).toBeLessThan(target.id);
    }
  });

  it("summarizes unread state by source and by folder", async () => {
    const bySource = await getUnreadSummary({});
    const byFolder = await getUnreadSummary({ group_by: "folder" });
    expect(bySource.total_unread).toBeGreaterThanOrEqual(0);
    for (const group of bySource.groups) {
      expect(group.source_id).toBeTruthy();
      expect(group.unread_count).toBeGreaterThan(0);
    }
    for (const group of byFolder.groups) {
      expect(group.folder_id).toBeTruthy();
      expect(group.read_inbox_max_id).toBeUndefined();
    }
  });

  it("advances the read pointer and the summary reflects it", async (ctx) => {
    const before = await getUnreadSummary({});
    const target = before.groups[0];
    if (!target) {
      ctx.skip();
      return;
    }

    const result = await markRead({ source_ids: [target.source_id!] });
    expect(result.failures).toEqual([]);
    expect(result.results[0]!.read_inbox_max_id).toBeGreaterThanOrEqual(
      target.read_inbox_max_id!,
    );

    const after = await getUnreadSummary({});
    const still = after.groups.find((g) => g.source_id === target.source_id);
    expect(still?.unread_count ?? 0).toBeLessThan(target.unread_count);
  });
});
```

- [ ] **Step 2: Run the live suite**

Run: `GRAMSCOPE_LIVE=1 npm run test:live`
Expected: PASS with no skips other than the two guarded `ctx.skip()` branches, and those only if the account genuinely has no second page or nothing unread. A skip in the pointer test means the account had zero unread; read something into it and re-run rather than accepting the skip.

This test marks a real channel read on the owner's account. That is intended — the account is a dedicated one, and spec §14 criterion 6 requires exactly this observation.

- [ ] **Step 3: Commit**

```bash
git add tests/live/reading.live.test.ts
git commit -m "test: exercise the reading tools against the real account"
```

---

## Task 14: Deploy and close the card

**Files:**
- Modify: `docs/superpowers/tasks/gramscope-mcp.md`

- [ ] **Step 1: Run every gate**

Run: `npm run test && npm run typecheck && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 2: Push to `main`**

```bash
git push origin main
```

Vercel's Git integration deploys on push. Wait for the deployment to finish before the next step.

- [ ] **Step 3: Verify the deployed server advertises seven tools**

The endpoint is OAuth-protected, so an unauthenticated probe must still answer 401 with a challenge:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  https://gramscope.vercel.app/api/mcp
```

Expected: `401`. The seven-tool check itself is owner-run in the ChatGPT connector UI — spec §14 criterion 3.

- [ ] **Step 4: Update the card**

In `docs/superpowers/tasks/gramscope-mcp.md`:

- Under "Review findings not yet addressed", remove the `tools/list` entry and add a dated line under "Changes and findings" recording that `tests/mcp-handler.test.ts` closed it.
- Add a dated line recording Task 1's outcome: whether Telegram accepted `channels.readHistory` for a peer resolved from a marked id on a cold instance, and, if it did not, what `mark_read` does instead.
- Add a dated line for the "Example News Channel" folder assignment: re-check it with `get_messages(source_ids: [...], limit: 5)` now that a message-reading tool exists, and record what the channel actually posts.
- Add the plan link under "Links": `plan (sub-project 2, Reading): docs/superpowers/plans/2026-08-27-gramscope-reading.md`.

- [ ] **Step 5: Commit and push**

```bash
git add docs/superpowers/tasks/gramscope-mcp.md
git commit -m "docs: close the tools/list finding and record sub-project 2 outcomes"
git push origin main
```

- [ ] **Step 6: Hand the owner-run acceptance checks over**

Spec §14 criteria 4–6 run in the ChatGPT connector UI and cannot be automated from here. Report them to the owner verbatim:

1. "What came in overnight in the AI folder" returns grouped messages from more than one channel in **one** tool call.
2. "Find the most interesting things from the past week, ignoring read state" returns a date-windowed read that does not consult unread state.
3. `mark_read` advances the pointer, and a subsequent `get_unread_summary` shows the new value.

---

## Self-Review

**Spec coverage.**

| Spec section | Task |
| --- | --- |
| §5.1 `get_messages` contract | 7, 11 |
| §5.2 `get_message` contract | 8, 11 |
| §5.3 `get_unread_summary` contract | 9, 11 |
| §5.4 `mark_read` contract | 10, 11 |
| §6 message schema | 2 (three fields omitted, documented in Global Constraints) |
| §7 fan-out, budget, ordering, `maxDuration` | 4, 6, 7, 11 |
| §8 cursor refactor and message cursor | 3 |
| §9 date, media-type and unread filters | 6, 7 |
| §10 access hash and the write path | 1, 10 |
| §11 errors | 7, 9, 10 (taxonomy unchanged) |
| §12 files | all; `src/telegram/messages.ts` split three ways, documented |
| §13 unit / handler / live tiers | 2–10 / 12 / 1, 13 |
| §14 acceptance criteria | 14 |

**Placeholder scan.** No "TBD", no "handle edge cases", no "similar to Task N". Every code block is written as it should land in the file.

**Type consistency.** `TelegramMessage`, `MessageContext`, `DialogEntry`, `DialogIndex`, `SliceRequest`, `Slice`, `MediaType`, `Fetched`, `SourceBlock`, `GetMessagesResult`, `UnreadGroup`, `MarkReadResult` are each defined once and referenced under the same name everywhere. `fetchSlice(client, request)` takes the client first in both its definition (Task 6) and its call site (Task 7). `folderMembers(folders, folderIds)` has the same argument order in Tasks 5, 7 and 9. `mapWithConcurrency(items, limit, fn)` matches in Tasks 4, 7 and 10.
