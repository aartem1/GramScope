# GramScope Discovery — design

Sub-project 4 of 6. Slug `gramscope-mcp`. Branch `main` — the owner works
directly on `main` until the project is fully launched. Brief: `README.md` §D
and §"Slice 4 — Source discovery". Card: `docs/superpowers/tasks/gramscope-mcp.md`.
Predecessor spec: `docs/superpowers/specs/2026-08-27-gramscope-research-design.md`.

## 1. Problem

Everything shipped so far reads sources the owner already subscribed to, or a
source somebody named by link. Nothing answers "which channels should I be
reading that I am not". The subscription list is the ceiling of the product, and
today it can only grow by the owner finding a channel in the Telegram app by
hand.

This sub-project lets ChatGPT propose candidates and hand them straight to the
reading tools, which already work on public channels the account has not joined.

## 2. Required outcome

Two tools on the deployed server, callable from ChatGPT:

| Tool | Purpose |
| --- | --- |
| `search_channels` | Find public channels by name or @username |
| `get_similar_channels` | Telegram's own recommendations — for one channel, or for the account as a whole |

Thirteen tools total after this sub-project.

## 3. Scope

In scope: the two tools, one discovery engine module, one new response schema,
and a live suite.

Out of scope: joining anything. Both tools are read-only and change no state;
`join_channel` is sub-project 5.

Out of scope, deferred to sub-project 6: the `note` field README §D asks
`search_channels` to return. Source notes live in the private `Source Meta`
channel, which does not exist yet, so the field would be permanently absent and
its acceptance would degenerate to "the key was missing, as expected". This is
the same argument that moved Saved Messages out of sub-project 3.

Out of scope: hashtag discovery through `channels.searchPosts(hashtag)`. It is
free and reaches all public channels, but the 2026-08-27 probe measured 26.8M
hits for `ai` dominated by SEO and spam channels. Turning that into a useful
tool needs a ranking story this sub-project does not have.

Out of scope: pagination. Neither TL method offers an offset (§4), so there is
nothing to page.

## 4. What this account can actually do

Measured live against the real account on 2026-08-28 with a throwaway probe,
now deleted; the numbers are on the card. The design is built on these facts
rather than on the API documentation.

| Capability | Result |
| --- | --- |
| `contacts.search` matching | **By name, not by topic.** `q=AI` returned zero public channels; `q=artificial intelligence` returned nine. It matches titles and usernames. |
| `contacts.search` volume | Caps global results at **10** whatever `limit` says — 50 and 200 returned the same page. No offset, no cursor. |
| `contacts.search` `broadcasts: true` | Drops users **and refills the quota with channels**: `q=нейросети` went from 9 mixed results (4 chats, 5 users) to 10 channels. |
| `contacts.search` fields | `title`, `participantsCount`, `verified`, `scam`, `fake`, `restricted`, `left`, `broadcast`, `megagroup`, `accessHash`. **No `about`.** |
| `contacts.search` usernames | Often `username: null` with the live handle in `usernames[]` (`chatgptv`, `neiroseti` both arrived that way). |
| `channels.getChannelRecommendations({channel})` | `messages.ChatsSlice`, `count: 79`, **10 chats served**. Non-Premium truncation, and no parameter reaches the rest. |
| `channels.getChannelRecommendations({})` | `messages.Chats`, **100 chats**, no `count`. Recommendations derived from the account's own subscriptions. |

Two consequences drive the whole design.

**Search is a name lookup.** A tool description that lets the model read it as a
topical search engine produces "there are no AI channels" from a query that was
merely too short. §6.1 makes this the first thing the description says.

**Descriptions are not free.** `about` requires one `channels.GetFullChannel`
per candidate. But every candidate arrives carrying its `accessHash`, so that
call needs no resolution step: the engine builds `InputChannel` from the id and
hash it already holds. Enrichment costs exactly one round trip per candidate and
never touches `contacts.ResolveUsername`, so the sub-project 3 lookup budget is
not involved.

## 5. Tool contracts

### 5.1 `search_channels`

```ts
{
  query: string    // required, non-empty
  limit?: number   // 1..10, default 10
}
```

Engine: `contacts.Search({ q: query, limit, broadcasts: true })`.

`broadcasts` is always set and is not exposed as an option. It costs nothing —
the quota refills with channels — and this product reads channels. A group or a
user the owner already knows by name is reachable through `get_channel`.

Response:

```ts
{
  candidates: DiscoveredSource[]
  truncated: boolean   // Telegram capped the page at 10
}
```

`candidates` merges `contacts.Found.myResults` and `.results`, keeps only
channel peers, and preserves Telegram's order with `myResults` first — a source
the account already holds is a stronger match for a name query than a stranger,
and Telegram itself puts it first. The two lists can name the same peer, so they
are de-duplicated by marked id, first occurrence winning.

`truncated` has one meaning in both tools: **the server held more candidates
than this response carries**, whether because Telegram capped the page or
because `limit` cut it. It is computed before the cut, from what Telegram
returned. There is no cursor to resume with and the description says so, so the
model narrows or rephrases instead of hunting for one.

An empty `candidates` is a successful call, never an error. The tool description
states the recovery explicitly: try the full name rather than an abbreviation,
or call `get_similar_channels` from a channel already known.

### 5.2 `get_similar_channels`

```ts
{
  source?: string   // marked id, @username, or t.me URL
  limit?: number    // 1..25, default 15
}
```

Engine: `channels.GetChannelRecommendations({ channel? })`. **The mode is
derived, never declared.** With `source` it returns channels similar to that
one; without it, channels recommended for the account from its own
subscriptions. One TL method, one code path, and no mode argument the model can
set wrongly.

Response:

```ts
{
  candidates: DiscoveredSource[]
  total_similar?: number   // seeded mode only, Telegram's own count
  truncated: boolean
}
```

`total_similar` is the `ChatsSlice.count` — 79 against 10 served on the probe.
It exists so the model can see it is looking at a slice, and the tool
description names the reason: the rest requires Telegram Premium and no
parameter reaches it. In global mode the response is `messages.Chats` with no
count, so the field is absent rather than invented.

`truncated` carries the §5.1 meaning here too, and in seeded mode it is true
whenever `total_similar` exceeds the number served — which, on a non-Premium
account, is every seeded call with more than ten neighbours.

`limit` only bites in global mode, where Telegram returns 100; in seeded mode
Telegram serves 10 and `limit` can only trim below that. It is a single
parameter rather than two because it means one thing — how many candidates to
enrich and return.

**Order is Telegram's and is never re-sorted.** Not by subscriber count, not by
anything else. README §D is explicit that the server must not decide which
candidate is best; ChatGPT inspects candidates and their recent posts with the
reading tools it already has.

## 6. The candidate schema

New file `src/schemas/discovery.ts`:

```ts
{
  id: string                     // marked id, e.g. -1004444444444
  title: string
  username?: string
  description?: string
  url?: string                   // https://t.me/<username>, when there is one
  type: "channel" | "group" | "chat"
  subscriber_count?: number
  joined: boolean
  verified: boolean
  scam: boolean
  fake: boolean
  restricted: boolean
}
```

It is a new schema rather than a widening of `telegramSourceSchema`, because a
candidate has no unread state and no folders, and widening the shared schema
would add fields to the declared `outputSchema` of four shipped tools that never
populate them.

`joined` comes from the dialog index, not from the entity's `left` flag. The
index is the same authority `resolve_telegram_url` already uses, it is loaded
once per call, and it is what every other tool means by "this account holds it".

The trust flags are free on the entity and are exactly the triage signal this
output needs: the 2026-08-27 probe recorded that public-channel discovery in
Telegram is dominated by SEO and spam channels. They are non-optional booleans —
an absent `scam` and a `false` one must not look the same.

`username` is read with `entityUsernames`, not `entityUsername`: the probe found
live handles that exist only in the `usernames[]` collectible list. **One risk
the plan must close before anything depends on it:** `entityUsernames` keeps
only entries with `active === true`, and the probe did not record whether
`contacts.search` sets that flag. A live test must assert that a candidate whose
`username` is null still comes back with a username, or the mapper must widen.

`OUTSIDE_SOURCE_GUIDANCE` is appended to both tool descriptions. A candidate is
by definition a channel the account does not hold, so its marked id will not
resolve on a cold serverless instance — `@username` is the only durable handle,
and this is the exact defect the sub-project 3 final review found.

## 7. Enrichment

Both tools enrich through one shared step. Candidates are cut to `limit` first,
then `channels.GetFullChannel` runs over them through `mapWithConcurrency` at
`FANOUT_CONCURRENCY` (8), with `InputChannel` built from the `id` and
`accessHash` the candidate already carries.

**A failed enrichment costs the description, never the call.** Each fetch is
caught individually and yields an empty detail set, exactly as `get_channel`
already does. A candidate with no description is a valid candidate; a discovery
call that dies because one channel of fifteen refused a full-info request is
not.

Responses pass through `fitToSizeCap` against `MAX_RESPONSE_BYTES` like every
other list-returning tool. With 25 candidates carrying a 255-character `about`
each the cap is not reachable in practice, so the guard exists for consistency
rather than for a measured case, and no cursor resumes what it drops — the
model narrows `limit` instead, which the description says.

## 8. Errors

| Case | Result |
| --- | --- |
| `query` empty or whitespace | `INVALID_INPUT` |
| `limit` out of range | Rejected by the schema |
| `source` names nothing resolvable | The mapped error from the shared resolver — `CHANNEL_NOT_FOUND` in practice |
| `source` is a private channel the account cannot reach | `PRIVATE_CHANNEL_NOT_ACCESSIBLE` |
| Telegram rate limit | `RATE_LIMITED`, as everywhere |
| No results, or a channel with no recommendations | Empty `candidates`, success |
| One enrichment fails | That candidate loses `description`; the call succeeds |

## 9. Files

New:

- `src/telegram/discovery.ts` — both engines and the shared candidate mapping
  and enrichment.
- `src/schemas/discovery.ts` — `discoveredSourceSchema`.
- `src/mcp/tools/search-channels.ts`, `src/mcp/tools/get-similar-channels.ts`.
- `tests/telegram-discovery.test.ts`, `tests/live/discovery.live.test.ts`.

Changed:

- `src/mcp/server.ts` — two registrations, 11 tools to 13.
- `tests/tools.test.ts` and `tests/mcp-handler.test.ts` — the exact-set
  assertions on the tool list.
- `src/telegram/peer-id.ts` — only if §6's `active` risk forces the mapper to
  widen.

`fetchChannelDetails` is reused from `src/telegram/dialogs.ts` as it stands. It
already takes an entity and returns `{ description, linkedDiscussionId }`, and
`InputChannel` is an acceptable entity for it.

## 10. Testing

Fast tier, against a fake client that returns fixture TL objects:

- `contacts.search` mapping: `myResults` before `results`, users dropped,
  channels kept, order preserved.
- A candidate whose `username` is null and whose handle is in `usernames[]`
  comes back with that handle.
- `joined` follows the dialog index, not the `left` flag — a fixture where the
  two disagree pins which one wins.
- `truncated` is true when Telegram returned more than `limit` keeps, true at a
  full page of 10, and false at 9 with `limit` above it.
- A peer present in both `myResults` and `results` appears once.
- `total_similar` is present in seeded mode and absent in global mode.
- Order is not re-sorted: a fixture whose subscriber counts ascend comes back
  ascending.
- One failing `GetFullChannel` costs one description and no more.
- `limit` cuts before enrichment, not after — assert the number of
  `GetFullChannel` calls, which is the whole point of cutting first.

Live tier, `GRAMSCOPE_LIVE=1`, house rule for the file: every loop is preceded
by an assertion on the length of what it iterates, so an empty result cannot
pass as green.

- `search_channels` with a query known to hit returns candidates with usernames,
  and at least one carries a description.
- `get_similar_channels` seeded from a channel the account holds returns
  candidates and a `total_similar` greater than the number served.
- `get_similar_channels` with no source returns candidates.
- A candidate the account holds reports `joined: true`; the suite skips visibly
  if the account holds none of the returned candidates.

Gates before acceptance, as in every prior sub-project: `npm test`,
`npm run typecheck`, `npm run lint`, `npm run build`, then the live tier.

## 11. Acceptance criteria

1. `tools/list` returns thirteen tools, including `search_channels` and
   `get_similar_channels`.
2. Fast and live gates green, live with no skips beyond the one visible skip
   §10 allows.
3. In the ChatGPT connector, the brief's discovery scenario completes: from a
   channel the owner likes, ChatGPT finds similar channels, reads their recent
   posts with the tools it already has, and recommends three — without the owner
   opening Telegram.
4. A candidate handed to `get_messages` by its `@username` reads successfully.

## 12. Open questions

None. The two decisions the owner had to make — `broadcasts` fixed on, and the
15/25 enrichment ceiling — were taken during brainstorming on 2026-08-28.

## 13. Decisions carried into later sub-projects

- A discovered candidate's durable handle is its `@username`. Sub-project 5's
  `join_channel` takes what discovery returns, so it must accept a username and
  must not require a marked id.
- The trust flags (`verified`, `scam`, `fake`, `restricted`) enter the codebase
  here. Sub-project 6's source notes describe sources the owner keeps, and
  nothing about a note should re-derive what the entity already states.
- Neither discovery tool paginates, and this is the first pair in the project
  that does not. The rule stays what sub-project 3 set: the response shape
  follows what the server actually offers, not a house convention applied for
  its own sake.
