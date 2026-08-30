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
      id: 900n,
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
  const identity = { sourceId: CHAT_ID, messageId: 42 };

  function documentMedia(document: Record<string, unknown>) {
    return {
      className: "MessageMediaDocument",
      document: {
        className: "Document",
        mimeType: "application/octet-stream",
        size: 0n,
        attributes: [],
        ...document,
      },
    };
  }

  it("classifies a round video as video_note and exposes dimensions/duration", () => {
    expect(mediaOf(documentMedia({
      id: 99n,
      mimeType: "video/mp4",
      size: 5000n,
      attributes: [{
        className: "DocumentAttributeVideo",
        roundMessage: true,
        w: 480,
        h: 480,
        duration: 12.5,
      }],
    }), { sourceId: CHAT_ID, messageId: 42 })).toMatchObject({
      media_id: expect.stringMatching(/^med_/),
      type: "video_note",
      width: 480,
      height: 480,
      duration_seconds: 12.5,
      size: 5000,
    });
  });

  it("changes media_id when attached media changes, not when file_reference changes", () => {
    const a = mediaOf(documentMedia({ id: 99n, fileReference: Buffer.from("a") }), identity);
    const b = mediaOf(documentMedia({ id: 99n, fileReference: Buffer.from("b") }), identity);
    const c = mediaOf(documentMedia({ id: 100n, fileReference: Buffer.from("a") }), identity);
    expect(a?.media_id).toBe(b?.media_id);
    expect(c?.media_id).not.toBe(a?.media_id);
  });

  it("leaves URL metadata download-free and without media_id", () => {
    expect(mediaOf({ className: "MessageMediaWebPage" }, identity)).toEqual({ type: "url" });
  });

  it("names a photo", () => {
    expect(mediaOf({ className: "MessageMediaPhoto" })).toEqual({
      type: "photo",
      has_thumbnail: false,
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
      has_thumbnail: false,
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
      media: {
        media_id: expect.stringMatching(/^med_/),
        type: "document",
        file_name: "paper.pdf",
      },
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
