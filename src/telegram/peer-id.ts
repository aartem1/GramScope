/**
 * Telegram carries a peer's id in two incompatible representations and this
 * module is the only place that knows the difference.
 *
 * BARE — the id as it appears inside a TL object: `InputPeerChannel.channelId`,
 * `Api.Channel.id`, `ChannelFull.linkedChatId`. Always positive, and ambiguous
 * on its own: the same number may name a channel, a legacy chat, or a user.
 *
 * MARKED — the disambiguated form teleproto exposes as `Dialog.id` and that
 * `TelegramSource.id` uses on the wire:
 *
 *   channel / megagroup  ->  -100 concatenated in front of the bare id
 *   legacy chat          ->  the bare id negated
 *   user                 ->  the bare id unchanged
 *
 * Mixing the two silently breaks every comparison between a dialog and a
 * folder's peer list, so nothing outside this file may construct either form
 * by hand.
 */

/**
 * Unwraps the shapes teleproto uses for Telegram ids — bigint, number, string,
 * or a BigInteger-like `{ value }` wrapper — into a decimal string. The result
 * is the BARE id; see `markedChannelId` and friends to disambiguate it.
 */
export function readBigId(value: unknown): string | undefined {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "value" in value) {
    return readBigId((value as { value: unknown }).value);
  }
  return undefined;
}

/** Bare channel/megagroup id -> marked id. */
export function markedChannelId(bare: string): string {
  return `-100${bare}`;
}

/** Bare legacy-chat id -> marked id. */
export function markedChatId(bare: string): string {
  return `-${bare}`;
}

const CHANNEL_CLASSES = new Set(["Channel", "ChannelForbidden"]);
const CHAT_CLASSES = new Set(["Chat", "ChatForbidden", "ChatEmpty"]);

function className(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const name = (value as { className?: unknown }).className;
  return typeof name === "string" ? name : undefined;
}

/**
 * MARKED id for an `InputPeer`-shaped object — the form `DialogFilter`
 * include/exclude lists are made of. Discriminated on which id field is
 * present, so it works whether or not `className` survived serialization.
 */
export function inputPeerMarkedId(peer: unknown): string | undefined {
  if (typeof peer !== "object" || peer === null) return undefined;
  const p = peer as Record<string, unknown>;

  const channel = readBigId(p.channelId);
  if (channel !== undefined) return markedChannelId(channel);

  const chat = readBigId(p.chatId);
  if (chat !== undefined) return markedChatId(chat);

  return readBigId(p.userId);
}

/**
 * MARKED id for a resolved entity (`Api.Channel`, `Api.Chat`, `Api.User`),
 * which carries its bare id in `id` and its kind in `className`.
 */
export function entityMarkedId(entity: unknown): string | undefined {
  if (typeof entity !== "object" || entity === null) return undefined;
  const bare = readBigId((entity as { id?: unknown }).id);
  if (bare === undefined) return undefined;

  const name = className(entity);
  if (name !== undefined && CHANNEL_CLASSES.has(name)) {
    return markedChannelId(bare);
  }
  if (name !== undefined && CHAT_CLASSES.has(name)) return markedChatId(bare);
  return bare;
}

/**
 * The single classification rule for `TelegramSource.type`, derived from the
 * entity rather than from a dialog's convenience flags so that dialogs and
 * `get_channel` cannot disagree about the same peer.
 */
export function sourceType(entity: unknown): "channel" | "group" | "chat" {
  const name = className(entity);
  if (name !== undefined && CHANNEL_CLASSES.has(name)) {
    const megagroup = (entity as { megagroup?: unknown }).megagroup;
    return megagroup === true ? "group" : "channel";
  }
  if (name !== undefined && CHAT_CLASSES.has(name)) return "group";
  return "chat";
}
