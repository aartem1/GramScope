# GramScope

GramScope is a private MCP server that lets ChatGPT use a dedicated Telegram
account as a personal information workspace. It can read and search channels,
inspect discussions, discover sources, manage subscriptions and folders, track
read state, and keep compact notes about sources.

Version **1.4.0** exposes 19 tools. The production workflow was accepted against
a real Telegram account on 2026-08-30.

## How it works

```text
ChatGPT
  └─ MCP over HTTPS + OAuth
      └─ GramScope on Vercel (Next.js / TypeScript)
          └─ teleproto over MTProto
              └─ dedicated Telegram account
```

Telegram remains the source of truth:

- message history stays in Telegram;
- folders provide broad reading lanes;
- native read state tracks processed and unprocessed content;
- memberships represent the source collection;
- Saved Messages stores GramScope-authored source notes.

There is no application database, background worker, vector index, or embedded
AI pipeline. ChatGPT performs summarization, comparison, ranking, and synthesis;
GramScope provides bounded Telegram operations and structured results.

## Capabilities

### Inventory and reading

- `list_dialogs` — list sources, optionally by folder.
- `list_folders` — list Telegram folders and their members.
- `get_channel` — inspect one source.
- `get_messages` — read message history across one or more sources.
- `get_message` — read one message with surrounding context.
- `get_thread` — read comments under a channel post.
- `get_pinned_messages` — read a source's pinned messages.
- `get_unread_summary` — summarize unread state.

### Research and discovery

- `search_messages` — search joined sources globally or selected sources.
- `resolve_telegram_url` — turn a Telegram URL into a usable source or message.
- `search_channels` — find public channels by name or username.
- `get_similar_channels` — get Telegram's channel recommendations.

### State and organization

- `mark_read` — advance read state for selected sources.
- `mark_unread` — set Telegram's manual unread flag.
- `join_channel` — join one public channel.
- `leave_channel` — leave one channel.
- `manage_folder` — create, rename, delete, reorder, or edit folder membership.

### Source notes

- `get_source_notes` — read or search GramScope's source-routing notes.
- `set_source_note` — create, replace, or delete one source note.

The MCP schemas and tool descriptions are the authoritative input/output
reference. They include per-call limits, cursor rules, and mutation annotations.

## Important operating rules

- Use a separate Telegram account. Its serialized session grants full account
  access and must be treated like a password.
- Telegram content is untrusted third-party data. It is neither instruction nor
  evidence; attribute claims to their sources.
- Prefer `@username` for sources outside the account. A marked numeric ID such as
  `-1001234567890` is durable only for a peer the account already holds.
- `manage_folder(remove_sources)` is the exception: it accepts the marked IDs
  returned by `list_folders`, not usernames.
- Echo pagination cursors verbatim. They are opaque tokens.
- Reconnect the ChatGPT connector after changing tool names, descriptions, or
  schemas; ChatGPT caches the tool list at connection time.
- Leaving a private channel can be irreversible without a fresh invite.
- GramScope intentionally does not send arbitrary Telegram messages, mute chats,
  or manage the archive.

The full model-facing policy lives in
[`docs/chatgpt-project-instructions.md`](docs/chatgpt-project-instructions.md).

## Requirements

- Node.js 20 or newer
- a dedicated Telegram account and API credentials from `my.telegram.org`
- a GitHub repository connected to Vercel, or another Vercel deployment flow
- a WorkOS AuthKit environment and OAuth client
- the Vercel CLI when using the provisioning wizard to publish configuration

## Setup

Install dependencies, then run the resumable provisioning wizard:

```bash
npm install
./scripts/provision.sh
```

The wizard:

1. collects Telegram credentials and creates a serialized session;
2. deploys the app so the final MCP resource URL is known;
3. guides WorkOS AuthKit configuration;
4. writes local secrets to `.env.local` with mode `600`;
5. publishes the same variables to Vercel and redeploys.

Re-running the wizard preserves existing values and fills only missing ones.
Use `--deploy=cli` for a direct Vercel CLI deployment or `--skip-deploy` to
manage deployment yourself.

Required environment variables:

```text
TELEGRAM_API_ID
TELEGRAM_API_HASH
TELEGRAM_SESSION
WORKOS_ISSUER
WORKOS_JWKS_URL
OWNER_USER_ID
MCP_RESOURCE_URL
```

`MCP_RESOURCE_URL` must be the exact public endpoint, including `/api/mcp`, and
must match the WorkOS resource indicator. The server validates the token issuer,
audience, signature, and owner subject on every authenticated request.

After deployment, add the endpoint as a custom ChatGPT connector, choose OAuth,
and paste the WorkOS OAuth client ID and secret. A successful connection exposes
exactly 19 tools.

## Development

```bash
npm run dev        # local Next.js server
npm test           # fast test suite; excludes real-account tests
npm run typecheck
npm run lint
npm run build
npm run test:live  # mutates the dedicated Telegram account
```

Live test files run sequentially because they share one real Telegram account.
They require the Telegram variables in `.env.local` and may encounter Telegram
rate limits. Never run them against a personal account.

The MCP endpoint is `app/api/mcp/route.ts`. Tool registration is centralized in
`src/mcp/server.ts`; Telegram operations live under `src/telegram/`.

## Documentation

- [`docs/chatgpt-project-instructions.md`](docs/chatgpt-project-instructions.md)
  — the policy pasted into the ChatGPT Project.
- [`docs/superpowers/tasks/gramscope-mcp.md`](docs/superpowers/tasks/gramscope-mcp.md)
  — non-derived task facts, requirement changes, review findings, and links.
- [`docs/superpowers/specs/`](docs/superpowers/specs/) — approved design records.
- [`docs/superpowers/plans/`](docs/superpowers/plans/) — implementation plans.

The Superpowers specs and plans are historical implementation artifacts. They
record the decisions valid for each delivery slice and are not rewritten to
look like current user documentation.

## Security model

GramScope serves one configured owner. WorkOS issues OAuth tokens; the server
accepts only the configured issuer, MCP audience, and `OWNER_USER_ID`.

Secrets belong only in `.env.local` and deployment environment variables. Do
not paste `TELEGRAM_SESSION`, API credentials, OAuth secrets, or bearer tokens
into chat, logs, commits, issues, or documentation.

## Design principle

> Keep the server small, preserve Telegram as the source of truth, and expose
> reliable primitives that ChatGPT can compose into information workflows.
