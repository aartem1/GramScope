/**
 * Appended to every tool description that takes or returns a source. It says
 * nothing about `joined`, because only resolve_telegram_url returns that
 * field: a rule the caller cannot evaluate from the tool's own output is not
 * guidance. It names @username rather than "a t.me URL" because a t.me/c/<id>
 * link is marked-id-based and just as unusable for a peer the account lacks.
 */
export const OUTSIDE_SOURCE_GUIDANCE =
  "Name a source by @username whenever it has one: a marked id like -1001234567890 resolves only for chats this account belongs to, so it is not a durable handle for a public channel reached by search or by link.";
