import { z } from "zod";
import { inputPeerMarkedId, readBigId } from "../telegram/peer-id";
import { mediaDescriptorSchema, mediaId, type MediaDescriptor } from "./media";

/**
 * Three fields from the design's §6 sketch are deliberately absent.
 *
 * `media.caption`: in TL a caption IS `Message.message`, already returned as
 * `text`. `author.username` and `forwarded_from.username`: each would cost one
 * `users.getUsers` per distinct author or origin. All three are omissions in
 * service of the 256KB page budget, which is what §6 exists to protect.
 */
export const messageMediaSchema = mediaDescriptorSchema.partial({
  media_id: true,
});

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
  media: messageMediaSchema.optional(),
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
type MediaIdentity = { sourceId: string; messageId: number };

function withIdentity(
  descriptor: Omit<MediaDescriptor, "media_id">,
  rawId: string | undefined,
  identity: MediaIdentity | undefined,
): TelegramMessage["media"] {
  return {
    ...descriptor,
    ...(rawId !== undefined && identity !== undefined
      ? { media_id: mediaId(identity.sourceId, identity.messageId, descriptor.type, rawId) }
      : {}),
  };
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

export function mediaOf(
  media: unknown,
  identity?: MediaIdentity,
): TelegramMessage["media"] | undefined {
  if (typeof media !== "object" || media === null) return undefined;
  const raw = media as Record<string, unknown>;
  if (raw.className === "MessageMediaWebPage") return { type: "url" };

  if (raw.className === "MessageMediaPhoto") {
    const photo = (raw.photo ?? {}) as Record<string, unknown>;
    const sizes = Array.isArray(photo.sizes)
      ? photo.sizes as Record<string, unknown>[]
      : [];
    const largest = sizes
      .filter((size) => finitePositive(size.w) && finitePositive(size.h))
      .sort((a, b) => Number(b.w) * Number(b.h) - Number(a.w) * Number(a.h))[0];
    return withIdentity({
      type: "photo",
      ...(largest ? { width: Number(largest.w), height: Number(largest.h) } : {}),
      has_thumbnail: sizes.length > 0,
    }, readBigId(photo.id), identity);
  }

  if (raw.className !== "MessageMediaDocument") {
    const name = String(raw.className ?? "");
    return name.startsWith("MessageMedia")
      ? { type: name.slice("MessageMedia".length).toLowerCase() }
      : undefined;
  }

  const document = (raw.document ?? {}) as Record<string, unknown>;
  const attrs = attributesOf(document);
  const animated = attrs.some((attr) => attr.className === "DocumentAttributeAnimated");
  const sticker = attrs.some((attr) => attr.className === "DocumentAttributeSticker");
  const video = attrs.find((attr) => attr.className === "DocumentAttributeVideo");
  const audio = attrs.find((attr) => attr.className === "DocumentAttributeAudio");
  const imageSize = attrs.find((attr) => attr.className === "DocumentAttributeImageSize");
  const filename = attrs.find((attr) => attr.className === "DocumentAttributeFilename")?.fileName;
  const type = animated ? "gif"
    : sticker ? "sticker"
    : video ? (video.roundMessage === true ? "video_note" : "video")
    : audio ? (audio.voice === true ? "voice" : "audio")
    : "document";
  const rawSize = readBigId(document.size);
  const size = rawSize === undefined ? undefined : Number(rawSize);
  const width = finitePositive(video?.w) ?? finitePositive(imageSize?.w);
  const height = finitePositive(video?.h) ?? finitePositive(imageSize?.h);
  return withIdentity({
    type,
    ...(typeof filename === "string" ? { file_name: filename } : {}),
    ...(typeof document.mimeType === "string" ? { mime_type: document.mimeType } : {}),
    ...(size !== undefined && Number.isSafeInteger(size) && size >= 0 ? { size } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...((video ?? audio) && finitePositive((video ?? audio)!.duration)
      ? { duration_seconds: Number((video ?? audio)!.duration) }
      : {}),
    has_thumbnail: Array.isArray(document.thumbs) && document.thumbs.length > 0,
  }, readBigId(document.id), identity);
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
  const media = mediaOf(m.media, { sourceId: ctx.chatId, messageId: id });

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
