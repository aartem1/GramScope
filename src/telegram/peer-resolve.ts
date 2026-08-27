import { resolveEntity, type TelegramLike } from "./client";
import type { DialogIndex } from "./dialog-index";
import { entityMarkedId, entityUsername } from "./peer-id";
import { GramScopeError } from "../errors/taxonomy";

/**
 * Spec §5. A source may be named three ways and this module is the only one
 * that knows the difference. Everything else takes a ResolvedSource.
 */
export type TelegramLink =
  | {
      kind: "username";
      username: string;
      messageId?: number;
      commentId?: number;
    }
  | {
      kind: "internal";
      markedId: string;
      messageId?: number;
      commentId?: number;
    }
  | { kind: "invite"; hash: string };

const USERNAME = /^[A-Za-z0-9_]{4,32}$/;
const MARKED_ID = /^-?\d{1,20}$/;
const TME = /^(?:https?:\/\/)?(?:www\.)?t\.me\/(.+)$/i;

function messageIds(
  rest: string[],
  query: string,
): { messageId?: number; commentId?: number } {
  // A forum topic link is t.me/name/<topic>/<msg>, so the LAST numeric
  // segment is the message; ?comment= names a comment under it.
  const numeric = rest.filter((part) => /^\d+$/.test(part)).map(Number);
  const comment = /[?&]comment=(\d+)/.exec(query);
  return {
    ...(numeric.length > 0 ? { messageId: numeric[numeric.length - 1]! } : {}),
    ...(comment ? { commentId: Number(comment[1]) } : {}),
  };
}

export function parseTelegramName(raw: string): TelegramLink {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new GramScopeError("INVALID_INPUT", "A source name cannot be empty");
  }

  const url = TME.exec(trimmed);
  if (url) {
    const [path, query = ""] = url[1]!.split("?", 2) as [string, string?];
    const parts = path.split("/").filter((part) => part.length > 0);
    const first = parts[0]!;

    if (first.startsWith("+")) {
      return { kind: "invite", hash: first.slice(1) };
    }
    if (first === "joinchat" && parts[1]) {
      return { kind: "invite", hash: parts[1] };
    }
    // t.me/c/<internal>/<msg> — a private peer addressed by its BARE id.
    if (first === "c" && parts[1] && /^\d+$/.test(parts[1])) {
      return {
        kind: "internal",
        markedId: `-100${parts[1]}`,
        ...messageIds(parts.slice(2), `?${query}`),
      };
    }
    // t.me/s/<name> is the public web preview of the same channel.
    const rest = first === "s" ? parts.slice(1) : parts;
    const name = rest[0];
    if (!name || !USERNAME.test(name)) {
      throw new GramScopeError(
        "INVALID_INPUT",
        `Unrecognized Telegram URL: ${trimmed}`,
      );
    }
    return {
      kind: "username",
      username: name,
      ...messageIds(rest.slice(1), `?${query}`),
    };
  }

  if (MARKED_ID.test(trimmed)) {
    return { kind: "internal", markedId: trimmed };
  }

  const bare = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  if (USERNAME.test(bare)) return { kind: "username", username: bare };

  throw new GramScopeError(
    "INVALID_INPUT",
    `Not a Telegram source name: ${trimmed}. Use a marked id like -1001234567890, a @username, or a t.me link.`,
  );
}

export type ResolvedSource = {
  /** Marked id — what every response reports as source_id. */
  source_id: string;
  title: string;
  username?: string;
  /**
   * What to hand to teleproto and what a cursor stores. A bare marked id
   * resolves only for peers the account holds, so a channel found by username
   * must keep travelling by username across cold instances.
   */
  handle: string;
  /** Present only when resolution went over the network. */
  entity?: Record<string, unknown>;
};

// Module scope, like the client itself: a warm Vercel instance keeps this
// between invocations, which is the whole saving.
const cache = new Map<string, ResolvedSource>();

export function __resetPeerCacheForTests(): void {
  cache.clear();
}

export async function resolveSource(
  client: TelegramLike,
  index: DialogIndex,
  raw: string,
): Promise<ResolvedSource> {
  const link = parseTelegramName(raw);
  if (link.kind === "invite") {
    throw new GramScopeError(
      "INVALID_INPUT",
      "An invite link is not a readable source. Call resolve_telegram_url to preview it; joining is not supported yet.",
    );
  }

  const key =
    link.kind === "username"
      ? `u:${link.username.toLowerCase()}`
      : `i:${link.markedId}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const held =
    link.kind === "internal"
      ? index.byId.get(link.markedId)
      : [...index.byId.values()].find(
          (candidate) =>
            candidate.username?.toLowerCase() === link.username.toLowerCase(),
        );

  if (held) {
    const resolved: ResolvedSource = {
      source_id: held.source_id,
      title: held.title,
      ...(held.username !== undefined ? { username: held.username } : {}),
      handle: held.username ?? held.source_id,
    };
    cache.set(key, resolved);
    return resolved;
  }

  const target = link.kind === "username" ? link.username : link.markedId;
  const entity = await resolveEntity(client, target);
  const markedId = entityMarkedId(entity);
  if (markedId === undefined) {
    throw new GramScopeError(
      "CHANNEL_NOT_FOUND",
      `Could not resolve ${raw} to a Telegram peer`,
    );
  }

  const username = entityUsername(entity);
  const title =
    typeof entity.title === "string"
      ? entity.title
      : typeof entity.firstName === "string"
        ? entity.firstName
        : markedId;

  const resolved: ResolvedSource = {
    source_id: markedId,
    title,
    ...(username !== undefined ? { username } : {}),
    handle: username ?? markedId,
    entity,
  };
  cache.set(key, resolved);
  return resolved;
}
