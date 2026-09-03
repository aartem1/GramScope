/**
 * Limits that both MCP tool schemas and Telegram domain modules share.
 *
 * These numbers are interpolated into `tools/list` descriptions and appear as
 * `.max()` bounds on input schemas. Changing a value changes the MCP surface
 * and forces a connector reconnect. The golden fixture in
 * `tests/fixtures/tools-list.json` is the tripwire.
 */

/**
 * Spec §5.1. A fan-out wider than this stops being one tool call and starts
 * being a job: 25 sources at limit 100 already fetches 2500 messages. Counted
 * over CANONICAL sources, because a caller naming one peer twice under two
 * names has still asked for one fan-out.
 */
export const MAX_SOURCES_PER_CALL = 25;

export const MAX_CONTEXT = 20;

export const MAX_MARK_READ_SOURCES = 25;

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

/** Telegram's non-Premium ceiling on chat folders. */
export const MAX_FOLDERS = 10;

/** Telegram's ceiling on peers in one folder, non-Premium. */
export const MAX_FOLDER_SOURCES = 100;

/**
 * Telegram's ceiling on a folder title, measured live on 2026-08-29 by
 * bisection against `messages.updateDialogFilter`: 12 characters is accepted,
 * 13 fails with MESSAGE_TOO_LONG. It appears in no TL schema and teleproto
 * does not model it, so it is checked here rather than discovered on the wire
 * — MESSAGE_TOO_LONG alone tells a caller nothing about which limit it hit.
 *
 * Counted in UTF-16 code units, which is what the measurement used. An emoji
 * title is therefore charged more than Telegram may charge it; the belt-and-
 * braces MESSAGE_TOO_LONG mapping in errors/from-telegram.ts keeps the other
 * direction actionable if the real rule ever turns out to be bytes or
 * codepoints.
 */
export const MAX_FOLDER_TITLE = 12;
