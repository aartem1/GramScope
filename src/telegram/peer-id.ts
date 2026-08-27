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
 * The single reader for a peer's public handle.
 *
 * Telegram carries usernames in two incompatible places, and — like the id
 * representations above — mixing them silently loses data. The legacy singular
 * `username` is still what most peers report. A peer that uses the
 * collectible/Fragment multiple-usernames feature reports `username: null`
 * instead and lists everything in `usernames: Username[]`, whose entries carry
 * `username` plus `active` and `editable` flags. `@exampleuser` is one such channel,
 * so reading only the singular field drops the handle for exactly the public
 * channels this server addresses by name — and `resolveSource` then falls back
 * to a bare marked id, which no cold instance can resolve.
 *
 * Order: the singular field first, so peers that still carry it behave exactly
 * as before; then the active editable username, which is the account's own
 * primary handle; then the first active one. An inactive username is never
 * returned — it no longer resolves.
 */
export function entityUsername(entity: unknown): string | undefined {
  if (typeof entity !== "object" || entity === null) return undefined;
  const e = entity as { username?: unknown; usernames?: unknown };

  if (typeof e.username === "string" && e.username.length > 0) {
    return e.username;
  }
  if (!Array.isArray(e.usernames)) return undefined;

  const active = e.usernames.filter(
    (candidate): candidate is { username: string; editable?: unknown } =>
      typeof candidate === "object" &&
      candidate !== null &&
      typeof (candidate as { username?: unknown }).username === "string" &&
      (candidate as { username: string }).username.length > 0 &&
      (candidate as { active?: unknown }).active === true,
  );

  const editable = active.find((candidate) => candidate.editable === true);
  return (editable ?? active[0])?.username;
}

/**
 * Every active public handle a peer answers to, primary first. `entityUsername`
 * above picks the one to travel by; this is for deciding whether a name the
 * caller wrote refers to this peer, where a secondary collectible username is
 * just as valid an answer as the primary one.
 */
export function entityUsernames(entity: unknown): string[] {
  if (typeof entity !== "object" || entity === null) return [];
  const primary = entityUsername(entity);
  const all = (entity as { usernames?: unknown }).usernames;
  const names = primary ? [primary] : [];

  if (Array.isArray(all)) {
    for (const candidate of all) {
      if (
        typeof candidate === "object" &&
        candidate !== null &&
        (candidate as { active?: unknown }).active === true &&
        typeof (candidate as { username?: unknown }).username === "string" &&
        (candidate as { username: string }).username.length > 0 &&
        !names.includes((candidate as { username: string }).username)
      ) {
        names.push((candidate as { username: string }).username);
      }
    }
  }

  return names;
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
