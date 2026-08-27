# GramScope Reading — design

Sub-project 2 of 6. Slug `gramscope-mcp`. Branch `gramscope-reading`. Brief:
`README.md` §B and §"Slice 2 — Core reading". Card:
`docs/superpowers/tasks/gramscope-mcp.md`. Predecessor spec:
`docs/superpowers/specs/2026-08-26-gramscope-foundation-design.md`.

## 1. Problem

Foundation shipped an OAuth-protected MCP server that can enumerate the owner's
Telegram sources and folders, but not read a single message. Every use case in
the brief — the overnight digest, historical research, deciding what is worth
attention — needs message content. This sub-project delivers it.

The owner's stated query shapes are two, and both must work:

- a date window regardless of read state: "find the most interesting things from
  the past week";
- an unread sweep: what has arrived since I last looked.

## 2. Required outcome

Four tools on the deployed server, callable from ChatGPT:

| Tool | Purpose |
| --- | --- |
| `get_messages` | Read message history across a flexible set of sources |
| `get_message` | Read one message with optional surrounding context |
| `get_unread_summary` | Report unread state per source or per folder |
| `mark_read` | Advance the read pointer |

Plus one carried-forward review finding closed: a test that exercises
`tools/list` through the real MCP handler.

## 3. Scope

In scope: the four tools above, the message schema, a message cursor, date
filtering, media-type filtering, and the read-pointer write.

Out of scope, deferred to sub-project 3 (Research): `search_messages`,
`get_thread`, `get_pinned_messages`, `resolve_telegram_url`, Saved Messages.
Out of scope, deferred to sub-project 5: joins, leaves, folder edits,
`mark_unread`. Media files are never downloaded — only their metadata is
returned.

## 4. Why `mark_read` is here and not in sub-project 5

The brief's reading loop is `get_unread_summary` → `get_messages(unread_only)`
→ `mark_read`. Without the third step the read pointer never advances, so every
digest returns the same growing pile and `unread_only` is decorative. The owner
chose to pull `mark_read` forward on the explicit basis that the Telegram
account is a fresh dedicated one where damaging state is acceptable.

Two consequences follow. First, this sub-project is no longer read-only, so
`readOnlyHint` stops being uniform: it is `true` on the three read tools and
`false` on `mark_read`, derived from the same fact that drives behaviour, as the
card's carried-forward decision requires. Second, the access-hash question the
card records as blocking every write must be answered here (§10).

## 5. Tool contracts

### 5.1 `get_messages`

Input:

| Field | Type | Notes |
| --- | --- | --- |
| `source_ids` | `string[]?` | Marked ids, as returned by `list_dialogs` |
| `folder_ids` | `string[]?` | Expanded server-side to their member peers |
| `exclude_source_ids` | `string[]?` | Subtracted from the union of the two above |
| `from` | `string?` | ISO 8601; inclusive lower bound on message date |
| `to` | `string?` | ISO 8601; inclusive upper bound on message date |
| `unread_only` | `boolean?` | Default `false` |
| `media_type` | `enum?` | One of `photo`, `video`, `document`, `audio`, `voice`, `url`, `gif` |
| `limit` | `int` | Messages **per source**. Default 20, min 1, max 100 |
| `cursor` | `string?` | Opaque; from a previous `next_cursor` |

The effective source set is `(source_ids ∪ expand(folder_ids)) \
exclude_source_ids`. At least one of `source_ids` or `folder_ids` must be
present. The effective set is capped at **25** sources; exceeding it is
`INVALID_INPUT` naming the count and telling the caller to split the call,
never a silent truncation.

Output:

```ts
{
  sources: Array<{
    source_id: string
    title: string
    messages?: TelegramMessage[]        // absent only when `error` is present
    has_more?: boolean                  // absent only when `error` is present
    error?: { code: string; message: string }
  }>
  next_cursor?: string
}
```

A source that was reached but matched nothing appears with an empty `messages`
array and `has_more: false`. A source that this page never reached — because
the size budget ran out first (§7) — is **absent** from `sources` and named in
`next_cursor` instead. The two cases must stay distinguishable: the first means
"nothing new here", the second means "ask again".

A source that failed carries `error` in place of `messages` (§11).

There is no per-source cursor. To read further into one source, call
`get_messages` again with that source alone. One cursor kind, not two.

### 5.2 `get_message`

Input: `source_id` (required), `message_id` (required, int),
`context_before` (int, 0–20, default 0), `context_after` (int, 0–20, default 0).

Output: `{ source_id: string, source_title: string, message:
TelegramMessage, context_before: TelegramMessage[], context_after:
TelegramMessage[] }`. The title sits at the top level rather than on each
message, for the reason given in §6. Context arrays are in ascending date
order. A missing target is `MESSAGE_NOT_FOUND`; missing context is simply a
shorter array, never an error.

### 5.3 `get_unread_summary`

Input: `group_by` (`"source" | "folder"`, default `"source"`),
`folder_ids` (`string[]?`, to narrow the report).

Output for `group_by: "source"`:

```ts
{
  groups: Array<{
    source_id: string
    title: string
    unread_count: number
    read_inbox_max_id: number
    latest_message_id?: number
    latest_message_date?: string
  }>
  total_unread: number
}
```

For `group_by: "folder"` the same rows carry `folder_id` and `title` instead of
`source_id`, `unread_count` is the sum over the folder's members, and
`read_inbox_max_id` is omitted because a folder has no single pointer.

This is built entirely from the dialog list — `unread_count`,
`read_inbox_max_id` and the dialog's top message are already on the `Dialog`
objects `list_dialogs` reads. It costs one `getDialogs` call, not one call per
source.

The oldest-unread date is deliberately **not** returned. It would cost one
extra request per source, and a caller that needs it can get it from
`get_messages(source_ids: [x], unread_only: true, limit: 1)`.

### 5.4 `mark_read`

Input: `source_ids` (`string[]`, 1–25), `up_to_message_id` (`int?`; when
omitted, the source's latest message).

Output:

```ts
{
  results: Array<{ source_id: string; read_inbox_max_id: number }>
  failures: Array<{ source_id: string; code: string; message: string }>
}
```

Both arrays are always present; either may be empty.

`annotations.readOnlyHint` is `false`. The description states plainly that this
mutates account state and that reading never does.

Per-source failure does not fail the call, so one inaccessible channel cannot
cost the caller the other twenty-four.

## 6. Message schema

`src/schemas/message.ts`, following the brief's §8 recommendation:

```ts
{
  id: number
  chat_id: string            // marked id
  date: string               // ISO 8601
  edit_date?: string
  text?: string
  url?: string               // https://t.me/<username>/<id> when public
  author?: { id?: string; name?: string; username?: string }
  views?: number
  forwards?: number
  replies?: number
  reactions?: Array<{ emoji: string; count: number }>
  forwarded_from?: {
    chat_id?: string; title?: string; username?: string
    message_id?: number; date?: string
  }
  media?: {
    type: string; file_name?: string; mime_type?: string
    size?: number; caption?: string
  }
  is_read?: boolean
}
```

`chat_title` and `chat_username` from the brief's sketch are omitted from the
message: the grouped response carries the title once per source block, and
repeating it on every message is the single largest avoidable cost in the
256 KB budget. `get_message` returns the source's title at the top level for
the same reason.

Message text is never truncated. An oversized page is handled by the size cap
(§7), not by mutilating individual messages.

## 7. Fan-out, budget and ordering

Sources are fetched **in parallel with a concurrency ceiling of 8**, so 25
sources do not become 25 simultaneous MTProto requests on one connection.

The response is then assembled source by source, in the requested order, while
it fits `MAX_RESPONSE_BYTES` (256 KB, already defined in `src/schemas/size.ts`).
The first source that does not fit whole is trimmed from its oldest end; the
sources after it contribute nothing to this page. Every source that still has
unserved history — trimmed, untouched, or simply not exhausted — is recorded in
`next_cursor`, and the following page resumes with exactly those. This
converges without any fairness rotation.

Messages within a source block are ordered **newest first**, matching
Telegram's own history order. No `order` parameter is offered: a caller that
wants ascending order can reverse a page it already holds, and a cross-page
ascending walk is not a use case either stated query shape needs.

`export const maxDuration = 60` is added to `app/api/mcp/route.ts`. The current
default of 10–15 s is not a safe budget for a 25-source fan-out.

## 8. Cursor

A second cursor kind, `k: "messages"`. Payload: the cursor version, the kind,
and a list of `{ source_id, offset_id }` for unexhausted sources only.

It is simpler than `DialogCursor`. Message ids inside a channel are strictly
monotonic and unique, so `offset_id` is an exact resume point: there is no
boundary-tie problem and therefore no `boundaryIds` list.

`src/pagination.ts` is currently hard-coded to dialogs — the envelope, the
base64url framing, and the `INVALID_CURSOR` mapping are all fused to
`DialogCursor`. It is refactored into a generic `encodePayload` /
`decodePayload(kind, schema)` pair with two thin codecs on top. A foreign
cursor still fails as `INVALID_CURSOR`, which is what §7 of the Foundation spec
requires. This is the only refactor in scope.

## 9. Filters

**Dates.** `to` maps natively to `offset_date`. `getHistory` has no lower
bound, so `from` is a client-side stop condition: history arrives descending, so
once a message predates `from` the source is exhausted. `from > to` is
`INVALID_DATE_RANGE` — the code already exists in the taxonomy.

**Media type.** `messages.getHistory` cannot filter. A typed request therefore
runs `messages.search` with an empty query and the matching TL filter
(`InputMessagesFilterPhotos`, `…Video`, `…Document`, `…Music`, `…Voice`,
`…Url`, `…Gif`), which is the same primitive the Telegram app uses for its
media tabs and which accepts `min_date` / `max_date` natively. Untyped requests
stay on `getHistory`. The two paths share one slice-fetching interface so
callers above them cannot tell the difference.

**Unread.** A message is unread when its id exceeds the source's
`read_inbox_max_id`. The pointers come from one `getDialogs` call for the whole
tool invocation, not one per source. `is_read` on each returned message is
derived from the same pointer.

## 10. Access hash and the write path

The card records "there is no access-hash story yet" as blocking every write
tool. Reading teleproto's `getInputEntity` shows the story already exists:
after the in-memory cache and the session cache both miss, the network path for
a channel calls `channels.getChannels` with `access_hash = 0`, which Telegram
accepts for channels the account holds, and returns the real hash. This is why
Foundation's `get_channel` resolves on a cold serverless instance, and the
resulting `InputPeerChannel` is equally valid for writes.

`mark_read` therefore uses `client.getEntity(marked_id)` like every read path,
then `channels.readHistory` for channels and `messages.readHistory` for legacy
chats. The cost is one extra round trip per peer on a cold instance; the
`_entityCache` absorbs it while the instance stays warm.

This reasoning is from source, not from a live write. **Task 1 of the
implementation plan verifies it against the real account on a cold instance**,
before any tool is built on the assumption. If Telegram rejects
`access_hash = 0` for `readHistory`, the finding lands in Task 1 rather than in
the final review, and `mark_read` falls back to resolving through the dialog
list.

## 11. Errors

The taxonomy in `src/errors/taxonomy.ts` is unchanged. This sub-project uses:

- `INVALID_INPUT` — no sources given, more than 25 sources, bad context bounds;
- `INVALID_DATE_RANGE` — `from` after `to`;
- `INVALID_CURSOR` — malformed, foreign, or outdated cursor;
- `MESSAGE_NOT_FOUND` — `get_message` target absent;
- `CHANNEL_NOT_FOUND`, `PRIVATE_CHANNEL_NOT_ACCESSIBLE`, `NOT_A_MEMBER`,
  `RATE_LIMITED` — mapped from Telegram by the existing `mapTelegramError`.

In `get_messages` a per-source failure does not fail the page: the source's
block carries `error: { code, message }` instead of `messages`, matching
`mark_read`'s `failures` in spirit. One dead channel must not cost a digest.

## 12. Files

Created:

- `src/schemas/message.ts` — the message schema and its TL mapper
- `src/telegram/messages.ts` — slice fetching, date bounds, unread filtering,
  fan-out and budget assembly
- `src/telegram/read-state.ts` — `mark_read`, kept separate from reads so the
  one mutating path is a file you can review on its own
- `src/mcp/tools/get-messages.ts`, `get-message.ts`,
  `get-unread-summary.ts`, `mark-read.ts`
- `tests/schemas-message.test.ts`, `tests/telegram-messages.test.ts`,
  `tests/telegram-read-state.test.ts`, `tests/mcp-handler.test.ts`

Modified:

- `src/pagination.ts` — generic envelope plus two codecs (§8)
- `src/mcp/server.ts` — register the four new tools
- `src/mcp/tool-result.ts` — `countOf` learns the `sources`-with-`messages`
  shape so the log line still reports a count
- `app/api/mcp/route.ts` — `maxDuration`
- `tests/live/foundation.live.test.ts` — extended, or a sibling
  `reading.live.test.ts`

## 13. Testing

Three tiers, following Foundation's established pattern.

**Unit** — against a faked `TelegramLike` injected through
`__setClientFactoryForTests`. Covers: source-set union and exclusion, the
25-source cap, date-bound stop condition, unread filtering against a read
pointer, budget assembly and trimming at the size cap, cursor round-trip,
foreign-cursor rejection, per-source error isolation, and the TL-to-schema
mapping of a message carrying reactions, a forward, and media.

**Handler** — `tests/mcp-handler.test.ts` drives `tools/list` through the real
`createMcpHandler` and asserts that all seven tools are present with valid JSON
schemas, and that `readOnlyHint` is `true` on the six read tools and `false` on
`mark_read`. This closes the review finding on the card: a tool dropped from
`registerTools` or given a malformed `inputSchema` currently ships silently and
presents to the owner as "connector connected, no tools available".

**Live** — against the real account: a cold-instance `mark_read` round trip
(§10), a fan-out over a real folder, a date-windowed read, an unread sweep, and
a two-page cursor walk asserting the pages are disjoint.

## 14. Acceptance criteria

1. `npm run test`, `npm run typecheck` and `npm run lint` pass.
2. The live suite passes against the real account with no skips.
3. `tools/list` on the deployed server reports all seven tools.
4. In ChatGPT: "what came in overnight in the AI folder" returns grouped
   messages from more than one channel in one tool call.
5. In ChatGPT: "find the most interesting things from the past week, ignoring
   read state" returns a date-windowed read that does not consult unread state.
6. `mark_read` advances the pointer, and a subsequent `get_unread_summary`
   reflects the new value.

Criteria 4–6 are run by the owner in the connector UI.

## 15. Open questions

None blocking. The access-hash assumption in §10 is verified by Task 1 of the
plan rather than left open, because a wrong answer changes only `mark_read`'s
internals, not this design.

## 16. Decisions carried into later sub-projects

- The message cursor's per-source `offset_id` list is the pattern for every
  later multi-source paginated tool, `search_messages` included.
- The grouped-by-source response shape is the house format for multi-source
  reads. Sub-project 3's search should match it rather than invent a flat one.
- `readOnlyHint` is now derived from behaviour rather than set uniformly. Every
  later write tool inherits that obligation.
- Per-source error isolation — a failing source degrades its own block, never
  the page — is the house rule for fan-out tools.
