# GramScope — Development Brief

## 1. Goal

Build a personal MCP server that gives ChatGPT broad access to a dedicated Telegram account used for information sources: news, research, technical channels, expert commentary, communities, long reads, reference material, and other useful feeds.

The primary UX is ChatGPT. Telegram is the source system and, where practical, also the storage layer.

The system should let ChatGPT independently decide how to:
- read new and historical content;
- search across channels and time ranges;
- inspect and discover sources;
- organize sources;
- track read/unread state;
- subscribe and unsubscribe from channels;
- save useful posts;
- maintain notes about sources.

The initial product is for a single user and a dedicated Telegram account.

---

## 2. Core principles

### Keep infrastructure minimal

Prefer:

`ChatGPT → MCP → Telegram`

Avoid additional infrastructure unless Telegram itself becomes insufficient.

Initial target:
- no VPS;
- no custom domain;
- no PostgreSQL;
- no Redis;
- no vector database;
- no separate AI pipeline;
- no permanent background worker.

### Telegram is the primary database

Use Telegram itself wherever possible for:
- message history;
- read/unread state;
- subscriptions;
- folders/categories;
- saved messages;
- source metadata/notes.

### ChatGPT is the intelligence layer

The MCP server should expose reliable primitives and rich data.

It should **not** try to:
- summarize content;
- cluster items semantically;
- decide importance;
- deduplicate content with its own AI;
- build its own agent/orchestrator.

ChatGPT should perform those tasks using MCP tools.

### Broad capabilities, small number of orthogonal tools

Expose enough functionality that ChatGPT can compose new workflows by itself.

Avoid mirroring every Telegram MTProto method as a separate MCP tool.

---

## 3. Main use cases

Examples the system should support naturally:

- "What important AI updates appeared overnight?"
- "Read only unread messages from my AI and World folders."
- "What were these channels saying about X two years ago?"
- "How did discussion of X change between 2024 and 2026?"
- "Find the earliest sources that mentioned Y."
- "Compare how different channels covered the same event or topic."
- "Find channels similar to this one."
- "Inspect these suggested channels and recommend which ones to subscribe to."
- "Subscribe to this channel and put it into AI / Research."
- "Mark everything you used for this summary as read."
- "Save this post for later."
- "What sources do I have for Russian tech news?"
- "Which channels have I not read for a long time?"
- "What unread material exists since yesterday evening?"

Scheduled ChatGPT tasks should also be able to use the MCP, for example:

> Every morning, read Telegram messages from selected folders for the previous night, merge duplicate items where appropriate, and send me a short digest.

No background collection is required for this use case because Telegram already stores message history.

---

## 4. High-level architecture

```text
┌────────────────────┐
│ ChatGPT             │
│ Project / Tasks     │
└─────────┬──────────┘
          │ MCP over HTTPS
          ▼
┌────────────────────┐
│ GramScope MCP       │
│ Vercel             │
│ TypeScript         │
└─────────┬──────────┘
          │ MTProto
          ▼
┌────────────────────┐
│ Dedicated Telegram │
│ user account       │
└────────────────────┘
```

Preferred initial stack:

- **Runtime:** TypeScript / Node.js
- **Hosting:** Vercel
- **MCP transport:** Streamable HTTP
- **Telegram client:** GramJS
- **Telegram auth:** user account via MTProto
- **Telegram session:** serialized string stored as a Vercel secret
- **MCP auth:** OAuth
- **OAuth provider target:** WorkOS AuthKit
- **Access control:** allow only one configured user identity

Python + Telethon remains an acceptable fallback if GramJS creates unnecessary friction.

---

## 5. Deployment model

### Vercel first

The MCP should be deployable as a normal HTTPS endpoint on a generated `*.vercel.app` domain.

No custom domain is required.

The server should be designed as stateless/serverless:

```text
MCP request
→ instantiate Telegram client
→ connect using serialized session
→ perform Telegram operation
→ disconnect / finish invocation
→ return result
```

A permanent Telegram connection is not required for the initial product.

### When Vercel would stop being enough

Move to an always-on host such as Render only if a future requirement genuinely needs continuous execution, for example:
- react to new Telegram messages immediately;
- preserve deleted messages before they disappear;
- run continuous event listeners;
- process every incoming post proactively.

Periodic ChatGPT tasks such as "check every morning" do **not** require an always-on process.

---

## 6. Authentication

The MCP must not be publicly usable even if somebody discovers its URL.

Target flow:

```text
ChatGPT
→ OAuth / PKCE
→ MCP
→ validate authenticated identity
→ allow only configured owner
```

Expected implementation:
- WorkOS AuthKit for OAuth;
- MCP-compatible OAuth flow;
- single-user allowlist;
- configured owner ID/email in environment variables;
- reject all other authenticated users;
- reject unauthenticated requests.

No users table is required.

Keep authorization simple initially:
- one owner;
- one broad MCP permission set.

Do not prematurely build granular scopes unless ChatGPT integration requires them.

### Secrets

Store only in deployment secrets:
- Telegram `API_ID`
- Telegram `API_HASH`
- serialized Telegram session
- OAuth secrets
- allowed owner identity

Never return secrets through MCP tools.

---

## 7. Telegram organization model

### Folders = source categories

Use native Telegram folders as the primary classification mechanism.

Possible examples:
- AI
- Tech
- World
- Russia
- Business
- Security
- Long Reads

The MCP must not hard-code these categories.

ChatGPT should be able to inspect and manage whatever folders exist.

### Saved Messages = saved items

Use Telegram Saved Messages for posts intentionally saved for later.

No separate bookmarks database in the MVP.

### Source notes = private Telegram metadata channel

Create one private Telegram channel owned by the dedicated account, for example:

`Source Meta`

Use it to store structured notes about subscribed or discovered sources.

Each source should have a stable machine-readable identifier in its note.

Suggested human-readable format:

```text
Source: @example_channel
Telegram ID: 123456789
Topics: AI, research
Type: primary / aggregator / commentary
Notes: Strong for model releases and research papers.
Tags: #source_123456789 #ai #research
```

Exact serialization may change during implementation.

Important properties:
- editable;
- searchable;
- understandable by a human;
- stable lookup by Telegram source ID;
- no external database required.

---

## 8. MCP resource model

Return rich structured entities instead of overly summarized output.

### Message

Recommended fields:

```ts
type TelegramMessage = {
  id: number
  chat_id: string
  chat_title?: string
  chat_username?: string

  date: string
  edit_date?: string

  text?: string
  url?: string

  author?: {
    id?: string
    name?: string
    username?: string
  }

  views?: number
  forwards?: number
  replies?: number

  reactions?: Array<{
    emoji: string
    count: number
  }>

  forwarded_from?: {
    chat_id?: string
    title?: string
    username?: string
    message_id?: number
    date?: string
  }

  media?: {
    type: string
    file_name?: string
    mime_type?: string
    size?: number
    caption?: string
  }

  is_read?: boolean
}
```

The exact schema can evolve, but do not strip useful Telegram metadata without reason.

### Channel / chat

Return at least:

```ts
type TelegramSource = {
  id: string
  title: string
  username?: string
  description?: string
  url?: string

  type: "channel" | "group" | "chat"

  subscriber_count?: number
  folder_ids?: string[]

  unread_count?: number
  read_inbox_max_id?: number

  linked_discussion_id?: string

  note?: string
}
```

---

## 9. MCP tool set

Names are provisional. Optimize naming and schemas during implementation for MCP/LLM ergonomics.

### A. Dialogs and source inventory

#### `list_dialogs`

List channels/chats available to the account.

Filters should support:
- folder;
- unread only;
- type;
- limit;
- cursor.

Useful output:
- source metadata;
- unread count;
- latest message date;
- folder membership.

---

#### `list_folders`

Return Telegram folders and their members.

Should expose:
- folder ID;
- name;
- included chats/channels;
- excluded chats where relevant;
- ordering.

---

#### `get_channel`

Get detailed information about a channel/chat.

Input:
- Telegram ID;
- username;
- Telegram URL.

Include source note if available.

---

### B. Reading

#### `get_messages`

Primary tool for retrieving content.

Possible scope:
- one channel;
- multiple channels;
- one folder;
- multiple folders.

Filters:
- `from`
- `to`
- `unread_only`
- message type
- limit
- cursor / pagination
- ascending / descending where useful.

Typical uses:
- overnight digest;
- all unread AI posts;
- messages from a selected group of sources.

---

#### `get_message`

Retrieve one exact Telegram message.

Allow:
- `context_before`
- `context_after`

Useful when ChatGPT receives a Telegram URL or needs surrounding context.

---

#### `get_thread`

Retrieve comments/replies linked to a channel post where Telegram exposes them.

Parameters:
- post/message;
- limit;
- cursor.

---

#### `get_pinned_messages`

Retrieve pinned messages for a source.

Useful for source descriptions, rules, indexes, and canonical resources.

---

#### `get_unread_summary`

Return unread state across sources/folders.

Should support grouping by:
- channel;
- folder.

Return:
- unread counts;
- oldest unread position/date where practical;
- latest message;
- read pointer.

This lets ChatGPT decide what to read without fetching everything.

---

### C. Search and historical research

#### `search_messages`

One of the most important tools.

Search scope:
- all accessible Telegram content;
- one folder;
- selected folders;
- selected channels;
- one channel.

Filters:
- query text;
- `from`;
- `to`;
- message/media type;
- limit;
- cursor.

Must support historical queries such as:
- last week;
- two years ago;
- arbitrary exact date ranges.

Do not impose artificial recent-history limits.

---

#### `search_saved_messages`

Search Saved Messages.

Parameters:
- query;
- dates;
- limit;
- cursor.

---

#### `get_saved_messages`

Retrieve Saved Messages by date range.

---

#### `resolve_telegram_url`

Accept a Telegram URL such as a channel or post URL and resolve it into structured Telegram entities.

Useful inputs:
- public channel link;
- direct post link;
- invite link where supported.

Return enough information for ChatGPT to call other tools.

---

### D. Source discovery

#### `search_channels`

Search for public Telegram channels/sources.

Return:
- title;
- username;
- description;
- subscriber count where available;
- whether already joined;
- note where available.

---

#### `get_similar_channels`

Use Telegram's native channel recommendations when available.

Input:
- source.

Return candidate channels with metadata.

Do not make the MCP itself decide which candidate is "best"; ChatGPT can inspect candidates and their recent history.

---

### E. Read state

#### `mark_read`

Mark content as read.

Support:
- one source;
- up to a specific message;
- possibly an explicit list/range if Telegram semantics allow this cleanly.

Important use case:

```text
ChatGPT fetches unread messages
→ creates digest
→ marks processed messages as read
```

Read state must use Telegram's native server-side state.

---

#### `mark_unread`

Mark a dialog/source unread using Telegram's native unread marker.

Useful for:
- "come back to this source later";
- restoring attention to something ChatGPT inspected but should not consider finished.

---

### F. Subscription management

#### `join_channel`

Join/subscribe to a public channel or supported invite.

Accept:
- username;
- URL;
- resolved source identifier.

Return resulting source metadata.

---

#### `leave_channel`

Unsubscribe/leave.

Return confirmation and source identity.

No separate local subscription state.

---

### G. Folder management

#### `manage_folder`

Prefer one composable tool rather than many tiny tools.

Supported actions:
- create;
- rename;
- delete;
- reorder;
- add sources;
- remove sources;
- inspect/update membership.

ChatGPT should be able to organize newly discovered sources itself.

---

### H. Saved content and notes

#### `save_message`

Save/bookmark a message into Telegram Saved Messages.

Prefer native forwarding/saving semantics where possible so the original source remains traceable.

---

#### `get_channel_note`

Get our metadata note for a source from the private `Source Meta` channel.

If no note exists, return a clean `not_found` result.

---

#### `set_channel_note`

Create or update the metadata note for a source.

Should use a stable source identifier to avoid duplicate notes when usernames change.

Possible fields:
- topics;
- source type;
- quality/usefulness note;
- strengths;
- weaknesses;
- tags;
- free-text notes.

ChatGPT may decide the content.

---

## 10. Explicitly excluded Telegram functions

Do not expose client-style features that do not help the information workflow.

Initially excluded:
- mute/unmute;
- notification settings;
- archive/unarchive;
- presence/status;
- profile customization;
- stories;
- calls;
- contact management;
- routine private messaging.

The dedicated Telegram account is not intended to be used as a normal interactive Telegram client.

---

## 11. Sending messages

Do **not** include arbitrary `send_message` in the initial implementation.

Reason:
- it is not needed for the core information/research use case;
- external Telegram content can contain prompt-injection-style instructions;
- read access plus source-management writes already covers the product.

Reconsider later if a concrete workflow requires it.

Writing to:
- Saved Messages;
- the private metadata channel;
- Telegram folders/subscriptions/read state

is in scope.

---

## 12. Pagination and limits

Every potentially large result set must support pagination.

Prefer:
- `limit`
- opaque `cursor`

over exposing raw Telegram offsets unless there is a strong reason.

Set a reasonable per-request maximum so a model cannot accidentally request an enormous Telegram history in one call.

Do **not** prevent large research tasks entirely.

ChatGPT should be able to paginate iteratively.

Example:

```text
search X between 2024-01-01 and 2024-12-31
→ first 100 results
→ inspect
→ fetch next page if needed
```

---

## 13. Date handling

Use ISO 8601 timestamps in MCP schemas.

All date-range tools should support explicit:
- `from`
- `to`

ChatGPT can translate natural-language ranges such as:
- "overnight";
- "yesterday";
- "two years ago";
- "summer 2024"

into exact dates before invoking tools.

Do not hide Telegram messages merely because they are old.

---

## 14. Search philosophy

### MVP

Use Telegram's own server-side search and history APIs.

Do not create:
- Elasticsearch;
- embeddings;
- vector search;
- mirrored Telegram archive.

### Known limitation

Telegram text search cannot provide true semantic retrieval for queries such as:

> Find old posts discussing ideas similar to autonomous coding agents even if they used completely different terminology.

This is acceptable initially.

ChatGPT can compensate by:
- generating alternative keywords;
- running multiple searches;
- searching selected channels;
- reading surrounding context.

Only add an external index if real usage proves this insufficient.

---

## 15. Read/unread semantics

Telegram's native read state is the source of truth.

The MCP must not maintain a parallel "processed" database initially.

Expected workflow:

```text
get_unread_summary
→ get_messages(unread_only=true)
→ ChatGPT analyses messages
→ mark_read
```

Important: tool descriptions should make it clear to ChatGPT that fetching a message and marking it read are separate operations.

A read operation must not silently mutate read state unless explicitly designed and documented.

---

## 16. Error handling

Return structured errors useful to an LLM.

Examples:
- `CHANNEL_NOT_FOUND`
- `PRIVATE_CHANNEL_NOT_ACCESSIBLE`
- `NOT_A_MEMBER`
- `RATE_LIMITED`
- `FLOOD_WAIT`
- `AUTH_REQUIRED`
- `OWNER_FORBIDDEN`
- `INVALID_DATE_RANGE`
- `INVALID_CURSOR`
- `MESSAGE_NOT_FOUND`
- `INVITE_EXPIRED`

For Telegram flood waits, return:
- error type;
- retry-after seconds if known.

Do not hide Telegram errors behind generic HTTP 500 responses.

---

## 17. Tool safety

The account is disposable/dedicated, so the security model can remain pragmatic.

Still enforce:
- OAuth on the MCP endpoint;
- one-user allowlist;
- secrets never exposed;
- no arbitrary MTProto method execution;
- no arbitrary code execution;
- explicit write tools;
- no hidden side effects in read tools.

ChatGPT should know from tool descriptions which tools mutate Telegram state.

---

## 18. Observability

Keep observability minimal.

Useful:
- Vercel request logs;
- MCP tool name;
- duration;
- Telegram API error class;
- result count.

Do not log:
- session string;
- OAuth secrets;
- full private message bodies unless specifically needed for debugging.

No dedicated monitoring stack initially.

---

## 19. Repository structure

Suggested starting point:

```text
gramscope/
├─ src/
│  ├─ mcp/
│  │  ├─ server.ts
│  │  ├─ auth.ts
│  │  └─ tools/
│  ├─ telegram/
│  │  ├─ client.ts
│  │  ├─ messages.ts
│  │  ├─ search.ts
│  │  ├─ channels.ts
│  │  ├─ folders.ts
│  │  ├─ read-state.ts
│  │  └─ notes.ts
│  ├─ schemas/
│  └─ errors/
├─ app/
│  └─ api/
│     └─ mcp/
├─ scripts/
│  └─ create-telegram-session.ts
├─ tests/
├─ README.md
└─ package.json
```

Adapt to the MCP/Vercel framework actually selected.

Avoid architecture for architecture's sake.

---

## 20. Telegram session bootstrap

Provide a local one-time script:

```text
npm run telegram:login
```

Run `./scripts/provision.sh` first — the login script reads its credentials from `.env.local`, so that file must already exist.

Expected flow:
1. enter Telegram phone number;
2. enter Telegram login code;
3. enter 2FA password if enabled;
4. create serialized MTProto session;
5. print/store it securely;
6. put it into Vercel environment secrets.

The deployed MCP should not need an interactive Telegram login.

---

## 21. Testing strategy

Prioritize deterministic integration behavior over elaborate unit-test coverage.

At minimum test:

### Auth
- unauthenticated request rejected;
- wrong user rejected;
- configured owner accepted.

### Telegram
- session connects;
- list dialogs;
- fetch message history;
- date-range history;
- historical search;
- unread state;
- mark read/unread;
- resolve URL;
- join/leave test channel where practical;
- folder operations;
- Saved Messages;
- metadata notes.

### MCP
- tools have valid schemas;
- pagination works;
- errors are structured;
- result sizes stay bounded;
- no read tool unexpectedly mutates Telegram state.

Mock Telegram where useful, but retain a small real-account integration suite because MTProto behavior matters.

---

## 22. Implementation order

Use Superpowers to refine the design before implementation, but the likely delivery order is:

### Slice 1 — Connectivity

- repository;
- Vercel MCP endpoint;
- OAuth;
- owner allowlist;
- Telegram StringSession connection;
- `list_dialogs`;
- `get_channel`.

### Slice 2 — Core reading

- `get_messages`;
- pagination;
- date ranges;
- `get_message`;
- `get_unread_summary`.

### Slice 3 — Research

- `search_messages`;
- `resolve_telegram_url`;
- `get_thread`;
- pinned messages;
- Saved Messages reading/search.

### Slice 4 — Source discovery

- `search_channels`;
- `get_similar_channels`.

### Slice 5 — State changes

- `mark_read`;
- `mark_unread`;
- `join_channel`;
- `leave_channel`;
- `manage_folder`;
- `save_message`.

### Slice 6 — Source metadata

- private `Source Meta` channel;
- `get_channel_note`;
- `set_channel_note`.

Then connect the MCP to ChatGPT and validate real workflows before adding infrastructure.

---

## 23. Acceptance scenarios

The MVP should be considered useful when ChatGPT can successfully complete all of these without manual Telegram browsing:

### Overnight digest

> Read everything new in AI and Tech since 23:00 yesterday. Tell me only what matters, merge duplicate items, cite the Telegram posts, and mark processed messages as read.

### Historical research

> What were my Telegram sources saying about Claude in August 2024? Compare the main narratives and show links to representative posts.

### Source discovery

> I like this channel. Find similar channels, inspect their recent posts, and recommend the best three.

### Source management

> Subscribe to these two channels, put them in AI, and write short source notes describing what each is useful for.

### Unread workflow

> What unread information do I currently have? Ignore low-value channels and summarize the rest.

### Saved research

> Find the Telegram posts I previously saved about coding agents.

---

## 24. Non-goals for the first version

Do not build unless real usage proves the need:

- external database;
- mirrored Telegram archive;
- semantic/vector index;
- own summarization model;
- background ingestion pipeline;
- realtime Telegram listener;
- web dashboard;
- mobile/desktop client;
- multi-user support;
- billing;
- sophisticated RBAC;
- custom domain;
- VPS;
- arbitrary messaging to other Telegram users;
- generic Telegram client functionality.

---

## 25. Open implementation questions

These should be resolved during Superpowers design/refinement rather than assumed now.

1. **GramJS vs Telethon**
   - Default: GramJS + TypeScript.
   - Switch to Telethon/Python only if Telegram support or session behavior is materially better.

2. **Exact MCP OAuth implementation**
   - Target: WorkOS AuthKit + single-user allowlist.
   - Verify the current ChatGPT Developer Mode / MCP authorization requirements at implementation time.

3. **Metadata note serialization**
   - Human-readable Telegram post vs a compact structured block.
   - Preserve stable lookup by numeric Telegram source ID either way.

4. **Global Telegram search behavior**
   - Confirm practical API limits, pagination behavior, and any paid/global-search constraints with the actual dedicated account.

5. **Threads/comments**
   - Confirm which linked-discussion cases are reliably accessible via the chosen Telegram library.

These are implementation details, not reasons to change the overall architecture.

---

## 26. Current architectural decisions

Treat these as accepted unless new evidence gives a concrete reason to revisit them.

- Dedicated Telegram account for informational sources.
- Personal Telegram remains separate.
- ChatGPT is the primary UI.
- Custom MCP is the integration boundary.
- Broad MCP capabilities are preferred over scenario-specific tools.
- Telegram is the source of truth.
- Telegram folders provide source classification.
- Telegram read state provides processed/unprocessed state.
- Saved Messages provide bookmarks.
- A private Telegram channel stores source notes.
- No separate database initially.
- No semantic/vector index initially.
- No background worker initially.
- No permanent Telegram connection initially.
- Vercel is the preferred first deployment target.
- No VPS and no custom domain initially.
- OAuth protects the MCP.
- Only one configured owner may use it.
- TypeScript + GramJS is the preferred initial implementation.
- Read tools must not silently mutate state.
- Subscription, folder, notes, Saved Messages, and read-state writes are allowed.
- Arbitrary messaging to other users is excluded initially.
- Mute/unmute is excluded.
- Archive/unarchive is excluded.
- ChatGPT performs summarization, clustering, ranking, and deduplication.
- The MCP exposes structured Telegram primitives and rich metadata.
- Historical access and search are first-class features.
- Scheduled ChatGPT digests and recurring research tasks should query Telegram on demand rather than rely on background ingestion.

---

## 27. Product principle

> Build the smallest possible MCP that gives ChatGPT sufficiently complete control over Telegram as a personal information system.

Do not predict every workflow.

Expose good primitives, preserve Telegram state, and let ChatGPT compose the workflows.

---

## Setup

```bash
./scripts/provision.sh
```

One pass, start to finish: Telegram credentials, the Telegram login, the first
Vercel deploy (which is what assigns your address), the WorkOS configuration
that depends on that address, then the variables and a redeploy. Re-running it
keeps whatever you already provided, so it is safe to resume after a failure.
Pass `--skip-deploy` to handle Vercel yourself.

The Telegram session is written straight into `.env.local` (mode 600,
gitignored) and is never printed. That file grants full access to the account —
treat it like a password. Production values live in Vercel environment
variables; nothing is stored in this repository.

One value must match in three places, or every request fails with 401: the
resource identifier. The wizard prints it and registers it for you in
`MCP_RESOURCE_URL`; you paste the same string into WorkOS under
Connect → Configuration → Resource Indicators.
