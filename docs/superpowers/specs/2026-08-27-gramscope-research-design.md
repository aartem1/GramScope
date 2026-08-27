# GramScope Research — design

Sub-project 3 of 6. Slug `gramscope-mcp`. Branch `main` — the owner works
directly on `main` until the project is fully launched. Brief: `README.md` §C
and §"Slice 3 — Research". Card: `docs/superpowers/tasks/gramscope-mcp.md`.
Predecessor spec: `docs/superpowers/specs/2026-08-27-gramscope-reading-design.md`.

## 1. Problem

Reading shipped the ability to sweep what arrived recently. It cannot answer a
question. Every research shape in the brief — "how did discussion of X change
between 2024 and 2026", "what did my channels say about this in March", "here is
a link, what is this and what did people say under it" — needs search, comment
threads, and a way to turn a URL somebody pasted into something callable.

This sub-project delivers that, and it is the first one whose reach extends
past the account's own subscriptions.

## 2. Required outcome

Four tools on the deployed server, callable from ChatGPT:

| Tool | Purpose |
| --- | --- |
| `search_messages` | Search across the whole account, or across chosen folders and sources |
| `get_thread` | Read the comment thread under a channel post |
| `resolve_telegram_url` | Turn a Telegram link or username into structured entities |
| `get_pinned_messages` | Read a source's pinned messages |

Eleven tools total after this sub-project.

## 3. Scope

In scope: the four tools, two new cursor kinds, a shared peer-resolution layer,
and the extension of the sub-project 2 reading tools to accept sources the
account has not joined.

Out of scope, deferred to sub-project 5 alongside `save_message`: Saved Messages
reading and search. The brief's Slice 3 lists them, but the dedicated account's
Saved Messages is empty and nothing writes to it until `save_message` exists, so
they would ship decorative and their acceptance would degenerate to "the call
did not fail". This is the same argument that moved `mark_read` forward into
sub-project 2, applied in the other direction.

Out of scope, deferred to sub-project 4: `search_channels`,
`get_similar_channels`. Out of scope, deferred to sub-project 5: joins, leaves,
folder edits. Media files are never downloaded — only their metadata is
returned.

## 4. What this account can actually do

Everything below was measured live against the real account on 2026-08-27 with
throwaway probes; the numbers are recorded in the card. The design is built on
these facts rather than on the API documentation.

| Capability | Result |
| --- | --- |
| `messages.searchGlobal` over the account's own chats | Free. ~300 ms per page. 12 pages x 50 walked with **zero duplicates** and no FLOOD_WAIT. Pages by `(offsetRate, offsetPeer, offsetId)`. `count` is a server-side total. `minDate`/`maxDate` and `broadcastsOnly` honored. |
| `messages.search` in one peer | Free. Pages by `offsetId`. **Works in a public channel the account has not joined.** |
| `channels.searchPosts(query)` — full text over all public channels | **PREMIUM_ACCOUNT_REQUIRED.** `channels.checkSearchPostsFlood` prices it at 10 Stars per query, 10 per day. |
| `channels.searchPosts(hashtag)` | Free and unrestricted, but returns SEO and spam channels. A weak discovery signal, not a research tool. |
| `contacts.search` | Free. Returns public channels the account has never joined, with `participantsCount`. |
| Reading a non-joined public channel | Works by username. `getMessages` and `messages.search` both succeed. |
| `messages.getReplies(peer = channel, msgId = post)` | Returns the comment thread **without joining the discussion group**. 20 per page, `offsetId` paging, zero overlap. Live `count` runs slightly ahead of the post's own counter. |
| Addressing the discussion group directly | **Fails, `CHANNEL_INVALID`.** The account holds 34 channels with a linked group and is a member of none. |
| A post with no comments, and a channel with no linked group | Both fail `getReplies` with the same `MSG_ID_INVALID` and are indistinguishable by error. |
| `channels.getFullChannel` | Floods fast: ~20 calls in 5 s triggered a 27 s FLOOD_WAIT, which teleproto absorbs by **sleeping**. |

Two consequences shape everything that follows.

**The Premium wall is real, and the compensation is reading.** Full-text search
of channels the account has not joined is not available. What is available is
naming such a channel by username and then reading or searching inside it for
free. So research reaches outside the subscriptions through a link or a name,
not through a query.

**A bare id is not a universal handle.** Sub-project 2 concluded that resolving
a peer from its marked id works for reads and writes alike. That holds only for
peers the account already holds. A channel it has never joined answers
`CHANNEL_INVALID` by id and resolves only by username; once resolved in-process
the id then works, but a fresh serverless instance loses that.

## 5. Naming a source

One field, a union of three forms. `source_ids` — and every other place a
source is named — accepts:

- a marked id, `-1001234567890`, resolved through the dialog index;
- a username, `@name` or `name`, resolved through `contacts.resolveUsername`;
- a `t.me` URL, parsed to one of the above.

`src/telegram/peer-resolve.ts` is the only module that knows the difference. It
returns a resolved peer plus the title and whatever metadata is available, and
memoizes resolutions for the life of the instance. The cost of an outside source
is one extra round trip per cold instance — the same cost class `get_channel`
already pays.

Rejected alternatives: a separate `external_sources` field, which forces the
model to classify a source before calling and duplicates every filter across two
fields; and a mandatory `resolve_telegram_url` step returning an opaque handle
carrying the access hash, which survives cold starts but adds a required round
trip, a new concept, and the storage of a value that expires.

## 6. Tool contracts

### 6.1 `search_messages`

```ts
{
  query: string                 // required, non-empty
  source_ids?: string[]         // marked id, @username, or t.me URL
  folder_ids?: string[]
  exclude_source_ids?: string[]
  from?: string                 // ISO 8601
  to?: string                   // ISO 8601
  media_type?: MediaType        // the sub-project 2 enum
  limit: number
  cursor?: string
}
```

**The mode is derived, never declared.** Neither `source_ids` nor `folder_ids`
present means account-wide search through one `messages.searchGlobal` call.
Either present means fan-out with `messages.search` per source, under the same
25-source ceiling and 8-way concurrency as `get_messages`. The model does not
choose an engine and cannot choose a wrong one.

`exclude_source_ids` applies to fan-out mode only. In global mode Telegram
offers no exclusion, and filtering the excluded peers out of a returned page
would silently shrink pages and break the `limit` contract; passing it with no
source selection is `INVALID_INPUT` naming the reason.

Response:

```ts
{
  results: Array<TelegramMessage & { source_title: string }>
  sources: Array<{
    source_id: string
    title: string
    hit_count: number
    error?: { code: string; message: string }
  }>
  total_matches?: number
  next_cursor?: string
}
```

`results` is ordered newest first. A hit carries no new id field: its `chat_id`
is the message schema's existing source identifier and equals the `source_id` of
its entry in `sources`. Only the title is added, so the model can read a hit
without a lookup.

`sources` is a roll-up over the current page only, so the model can see which
sources carry the topic without scanning every hit. In fan-out mode it also
carries per-source failures (§7). `total_matches` is Telegram's own count for
the query within scope in global mode (4820 for the probe query), and the sum of
the per-source counts in fan-out mode; it is an estimate that drifts, and the
tool description says so — it is there to decide whether to narrow, not to
compute with.

**Dates and media type are filtered by Telegram, not by us.** Both engines take
`minDate`/`maxDate` and a `filter` natively, so unlike `get_messages` — where
`getHistory` has no lower bound and no media filter, and sub-project 2 had to
stop client-side — there is no client-side filtering here and no partial page
caused by one.

### 6.2 `get_thread`

```ts
{ source_id: string; post_id: number; limit: number; cursor?: string }
```

Two RPCs. The post is fetched first, and its own `replies` block decides what
happens next:

- no `replies` block → the channel has no linked discussion group →
  `NO_DISCUSSION_THREAD`;
- `replies.replies === 0` → the thread exists and is empty → **an empty result,
  not an error**;
- otherwise → `messages.getReplies`.

This is why the extra round trip is worth paying: without it both conditions
arrive as the same `MSG_ID_INVALID` and cannot be told apart.

Response:

```ts
{
  source_id: string
  source_title: string
  post: TelegramMessage
  discussion_chat_id?: string
  comment_count: number
  comments: TelegramMessage[]
  next_cursor?: string
}
```

The post is returned as the thread's root, so one call gives the model the
subject and the reaction to it. `comment_count` is `getReplies`'s live count,
which runs slightly ahead of the post's own counter; the description says which
one it is.

`discussion_chat_id` identifies the group but **is not an address**. Feeding it
to `get_messages` fails, because the account does not hold that peer. The tool
description states this, since a model that sees an id will otherwise try to use
it.

Comments carry no `is_read`: the account is not a member of the discussion
group and has no read pointer there. Page size follows `limit`; the cursor
resumes from the oldest comment served.

### 6.3 `resolve_telegram_url`

```ts
{ url: string }
```

Accepts `t.me/name`, `t.me/name/123`, `t.me/name/123?comment=456`,
`t.me/c/<internal>/<msg>`, `t.me/+hash`, `t.me/joinchat/hash`, a bare `@name`,
and a bare `name`.

Response:

```ts
{
  kind: "source" | "post" | "invite"
  source?: {
    source_id?: string
    title: string
    username?: string
    type: "channel" | "group" | "chat"
    subscriber_count?: number
    linked_discussion_id?: string
    joined: boolean
    folder_ids?: string[]
  }
  message_id?: number
  comment_id?: number
}
```

Invite links go through `messages.checkChatInvite`, which previews a private
chat without joining: title and participant count come back, `joined` is false,
and `source_id` is absent because a preview carries no usable peer. The
description says reading it requires a join, which lives in sub-project 5.

`t.me/c/<internal>/<msg>` resolves only for peers the account holds; for
anything else it is `CHANNEL_NOT_FOUND`, because a private internal id carries
no access hash.

The tool never joins anything. `readOnlyHint` is true.

### 6.4 `get_pinned_messages`

```ts
{ source_id: string; limit: number; cursor?: string }
```

One source, `messages.search` with `InputMessagesFilterPinned`, newest first,
cursor by `offset_id`. Returns the same message shape as everything else. A
source with no pinned messages returns an empty list, not an error.

## 7. Ordering, budget and the fan-out cursor

Global mode returns one Telegram page, already ordered by the server's rate,
which tracks date. Nothing is merged.

Fan-out mode fetches sources in parallel at concurrency 8 and merges their
results **by date, newest first**, then truncates to `limit` and to
`MAX_RESPONSE_BYTES` (256 KB, already defined). Because each source's stream is
independently ordered, the resume point is simply the id of the last hit served
from that source, or its starting offset if it served none. There is no
trimmed-block bookkeeping of the kind `compose` needs in sub-project 2, where
the group order is fixed and the budget can run out inside a block.

Per-source error isolation is unchanged from the house rule: a source that fails
contributes an entry to `sources` carrying an error and never fails the page.

`export const maxDuration = 60` already covers a 25-source fan-out.

## 8. Cursors

Two new kinds, both carrying a **scope fingerprint**: a hash of the query and
every filter that defines the result set. If a caller changes the query or the
date window between pages, the cursor is rejected as `INVALID_CURSOR` with a
message saying the scope changed and that a new search must start without a
cursor. Without this the second page would silently answer a different question
than the first — and sub-project 2 already established that a model will alter a
cursor it was told to echo.

- `k: "search_global"` — `{ rate, peer, id, fingerprint }`.
- `k: "search_sources"` — `{ sources: [{ source_id, offset_id }], fingerprint }`.

Both reuse the generic envelope and base64url framing `src/pagination.ts` grew
in sub-project 2. A foreign cursor still fails as `INVALID_CURSOR`, and the
opaque-token wording added after acceptance stays.

The `cursor` parameter description repeats the opaque-token contract that
sub-project 2 acceptance proved necessary: pass it back character for character.

## 9. Why search results are flat and not grouped

Sub-project 2 carried forward a decision: the grouped-by-source response shape
is the house format for multi-source reads, and "sub-project 3's search should
match it rather than invent a flat one". **This spec overturns that decision for
search only**, on evidence that was not available when it was made.

A global search page is a slice of a ranked stream across all chats. Grouping it
makes the group boundaries an artifact of the page: the same source reappears as
a fresh group on every subsequent page, and the chronology a research question
depends on has to be reassembled by the model. In fan-out reading, by contrast,
groups are stable — one per requested source — which is what makes the format
right there.

So `get_messages` keeps groups and `search_messages` returns a flat list with
`source_id` and `source_title` on every hit, plus a `sources` roll-up that
preserves the "which sources discuss this" signal grouping used to give. One
shape covers both search modes; the model never has to branch on the response.

## 10. Changes to sub-project 2 code

`get_messages`, `get_message` and the dialog index learn to accept the union of
§5 by routing every source name through `peer-resolve.ts`. A source outside the
index has no folder membership, no unread count and no read pointer, so
`is_read` is undefined for its messages and it can never be reached through
`folder_ids` — only by being named.

This is deliberate scope in the sub-project rather than drift: without it a
resolved link is a dead end, and the asymmetry "you may search a channel you
cannot page" is worse than either extreme.

**`channels.getFullChannel` is never fanned out.** It supplies
`subscriber_count` and `linked_discussion_id`, and it floods after roughly 20
calls with a 27-second wait that teleproto absorbs by sleeping — so a fan-out
over it does not fail, it silently consumes the entire request budget. At most
one call per tool invocation, in `resolve_telegram_url` and `get_channel` only.
This is a prohibition, not a preference.

## 11. Errors

One new code, `NO_DISCUSSION_THREAD`, for a post in a channel that has no linked
discussion group. Everything else reuses the existing taxonomy:
`CHANNEL_NOT_FOUND` for an unresolvable name, `MESSAGE_NOT_FOUND` for a missing
post, `INVALID_INPUT` for an empty query, a bad source name, or
`exclude_source_ids` passed without a source selection (§6.1),
`INVALID_DATE_RANGE`, `INVALID_CURSOR`, `RATE_LIMITED`.

An empty result is never an error: no hits, no comments and no pinned messages
are all empty successes.

## 12. Files

Created:

- `src/telegram/peer-resolve.ts` — the three ways to name a peer, and the only
  module that knows them
- `src/telegram/search.ts` — both engines, merging, budget
- `src/telegram/thread.ts` — the post pre-check and the comment page
- `src/telegram/resolve.ts` — URL parsing and entity resolution
- `src/telegram/pinned.ts`
- `src/mcp/tools/search-messages.ts`, `get-thread.ts`,
  `resolve-telegram-url.ts`, `get-pinned-messages.ts`
- `tests/telegram-peer-resolve.test.ts`, `tests/telegram-search.test.ts`,
  `tests/telegram-thread.test.ts`, `tests/telegram-resolve.test.ts`,
  `tests/live/research.live.test.ts`

Modified:

- `src/pagination.ts` — two new codecs and the scope fingerprint
- `src/errors/taxonomy.ts` — `NO_DISCUSSION_THREAD`
- `src/telegram/messages.ts`, `src/telegram/dialog-index.ts` — outside sources
- `src/mcp/server.ts` — register four tools
- `src/mcp/tool-result.ts` — `countOf` learns the `results` shape
- `tests/mcp-handler.test.ts` — eleven tools, all read-only

## 13. Testing

**Unit**, against a faked `TelegramLike`: mode selection from arguments;
`exclude_source_ids` rejected in global mode; date-ordered merge and the resume
point it implies; the size cap; cursor round trip for both kinds; a cursor
rejected when the fingerprint changes; the three `get_thread` branches; every
URL form including `?comment=`; peer resolution for each of the three naming
forms; per-source error isolation.

**Handler** — `tests/mcp-handler.test.ts` extended to eleven tools with
`readOnlyHint` true on all four new ones.

**Live**, against the real account: two disjoint pages in global mode; two
disjoint pages in fan-out mode over a real folder; a comment thread on a real
post with more than one page; a `NO_DISCUSSION_THREAD` on a channel that has no
linked group; a URL for a public channel the account has not joined resolved and
then read through `get_messages`; and the asymmetry pinned as a regression —
that same channel's marked id rejected on a cold client while its username
works.

## 14. Acceptance criteria

1. `npm run test`, `npm run typecheck` and `npm run lint` pass.
2. The live suite passes against the real account with no skips.
3. `tools/list` on the deployed server reports all eleven tools.
4. In ChatGPT: a search across the whole account with a date window two years
   back returns hits and a `next_cursor` that is accepted on the next call.
5. In ChatGPT: a search restricted to one folder returns hits from more than one
   channel in a single tool call.
6. In ChatGPT: `get_thread` on a post that has comments returns the post and its
   comments.
7. In ChatGPT: a link to a public channel the account has not joined resolves,
   and `get_messages` then reads that channel.

Criteria 4-7 are run by the owner in the connector UI. The connector caches its
tool list at install time, so it must be reconnected before acceptance — this
cost sub-project 2 a full diagnosis round.

## 15. Open questions

None blocking. Both questions the card addressed to the owner were answered by
live probe before this spec was written.

## 16. Decisions carried into later sub-projects

- The three-form source name (marked id, username, `t.me` URL) is the house
  input format. Every later tool that names a source accepts all three through
  `peer-resolve.ts`.
- A bare marked id is only a handle for peers the account holds. Anything
  reaching outside the subscriptions must carry a username or resolve one.
- Search results are flat; multi-source reads stay grouped. The shape follows
  whether the page's groups are stable, not the tool's arity.
- Every cursor over a filtered result set carries a scope fingerprint.
- `channels.getFullChannel` is never fanned out.
- Full-text search of public channels the account has not joined costs Stars and
  requires Premium. Sub-project 4 must build discovery on `contacts.search` and
  channel recommendations, not on post search.
