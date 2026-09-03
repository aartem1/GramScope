import { entityMarkedId } from "../peer-id";

const SUPPORTED_CLASSES = new Set([
  "messages.Messages",
  "messages.MessagesSlice",
  "messages.ChannelMessages",
]);

/**
 * The flat view of every messages.* TL result this project reads:
 * messages.Messages (bounded, no count), messages.MessagesSlice (count, and a
 * nextRate on a global search) and messages.ChannelMessages (count, no rate).
 */
export type TlMessagesPage = {
  messages: Record<string, unknown>[];
  /** Marked id -> title, taken from the chats the response already carried, so
   *  naming a hit's source costs no extra round trip. */
  titles: Map<string, string>;
  /** Server-side total for the query. Absent on a bounded result. */
  count?: number;
  /** messages.searchGlobal's resume key. Absent everywhere else. */
  nextRate?: number;
};

function records(value: unknown): Record<string, unknown>[] {
  // Array.from: teleproto hands back an Array subclass carrying `total`, and
  // filter/map preserve it through Symbol.species.
  return Array.isArray(value)
    ? Array.from(value).filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null,
      )
    : [];
}

export function readMessagesPage(raw: unknown): TlMessagesPage {
  const page = (typeof raw === "object" && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >;

  const className = page.className;
  if (typeof className !== "string" || !SUPPORTED_CLASSES.has(className)) {
    return { messages: [], titles: new Map() };
  }

  const titles = new Map<string, string>();
  for (const chat of records(page.chats)) {
    const id = entityMarkedId(chat);
    if (id !== undefined && typeof chat.title === "string") {
      titles.set(id, chat.title);
    }
  }

  return {
    messages: records(page.messages),
    titles,
    ...(className !== "messages.Messages" && typeof page.count === "number"
      ? { count: page.count }
      : {}),
    ...(className === "messages.MessagesSlice" &&
    typeof page.nextRate === "number"
      ? { nextRate: page.nextRate }
      : {}),
  };
}
