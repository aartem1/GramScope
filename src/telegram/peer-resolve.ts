import { resolveEntity, type TelegramLike } from "./client";
import type { DialogEntry, DialogIndex } from "./dialog-index";
import { entityMarkedId, entityUsername } from "../peer-id";
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

/**
 * One canonical key per way of writing a name, so two spellings of the same
 * peer collapse before anything is resolved. A name that does not parse falls
 * back to its trimmed, lowercased self: such a name can only ever become an
 * error row, and two identical unparseable names are still one row.
 */
export function nameKey(raw: string): string {
  let link: TelegramLink;
  try {
    link = parseTelegramName(raw);
  } catch {
    return `raw:${raw.trim().toLowerCase()}`;
  }
  if (link.kind === "username") return `u:${link.username.toLowerCase()}`;
  if (link.kind === "internal") return `i:${link.markedId}`;
  return `v:${link.hash}`;
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

/** The dialog index answers for every peer the account holds, and only for
 *  those; a miss is what costs a network round trip. */
function heldEntry(
  index: DialogIndex,
  link: TelegramLink,
): DialogEntry | undefined {
  if (link.kind === "invite") return undefined;
  if (link.kind === "internal") return index.byId.get(link.markedId);
  return byUsername(index).get(link.username.toLowerCase());
}

/**
 * Usernames of held peers, built once per index. `heldEntry` used to scan every
 * entry per name, which a caller could drive: the arrays that reach it are
 * caller-supplied and the scan is linear in the account's dialog count.
 * Keyed on the index object so `DialogIndex` keeps its shape, and first-wins so
 * a duplicate username resolves the way the old scan did.
 */
const usernameIndexes = new WeakMap<DialogIndex, Map<string, DialogEntry>>();

function byUsername(index: DialogIndex): Map<string, DialogEntry> {
  let map = usernameIndexes.get(index);
  if (map) return map;

  map = new Map();
  for (const entry of index.byId.values()) {
    const name = entry.username?.toLowerCase();
    if (name && !map.has(name)) map.set(name, entry);
  }
  usernameIndexes.set(index, map);
  return map;
}

/**
 * What resolving this name will cost, before spending any of it.
 *
 * `local` — the dialog index answers, no round trip.
 * `network` — a round trip to Telegram.
 * `never` — the name cannot be resolved at all: it does not parse, or it is an
 * invite link. `resolveSource` answers those with their own error, so a budget
 * that counted them would diagnose an unusable name as a lookup overflow and
 * ask for a split that cannot help.
 *
 * The module-level resolve cache is deliberately not consulted: counting it
 * would make the same request legal on a warm instance and rejected on a cold
 * one.
 */
export type ResolutionCost = "local" | "network" | "never";

export function resolutionCost(
  index: DialogIndex,
  raw: string,
): ResolutionCost {
  let link: TelegramLink;
  try {
    link = parseTelegramName(raw);
  } catch {
    return "never";
  }
  if (link.kind === "invite") return "never";
  return heldEntry(index, link) === undefined ? "network" : "local";
}

/** The marked id this name reaches without a round trip, if any. Lets a caller
 *  count part of its selection exactly before deciding to spend lookups. */
export function localSourceId(
  index: DialogIndex,
  raw: string,
): string | undefined {
  try {
    return heldEntry(index, parseTelegramName(raw))?.source_id;
  } catch {
    return undefined;
  }
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

  const held = heldEntry(index, link);

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
