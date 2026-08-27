# GramScope

A personal Telegram MCP server for ChatGPT. Read-only tools over MTProto
(`teleproto`), deployed to Vercel, authenticated by OAuth via WorkOS AuthKit.

## Resuming work

Run `/sp:next` from the repository root. It derives the stage from disk and git
and needs no argument.

Doing it by hand: `docs/superpowers/tasks/gramscope-mcp.md` is the authoritative
record. Its **Handoff** section names the current commit range, what is deployed,
what is in flight and what must not be redone; **Changes and findings** holds
every ruling and measurement the work rests on. Read both before touching code.

`.superpowers/sdd/<plan>/progress.md` is the per-task ledger `/sp:next` reads.
It is git-ignored by the plugin's own `.gitignore`, so it exists on this machine
and nowhere else — the card is what a clone carries. Keep both current as work
happens, and treat the card as the one that has to survive.

## Standing rules

- **Work directly on `main`.** The owner keeps no feature branches until the
  project launches.
- **A push to `main` deploys to Vercel production.** Ask the owner before
  pushing; the deploy is the outward-facing side effect, not the commit.
- **Credentials live in `.env.local` and the Vercel environment.** The
  `TELEGRAM_SESSION` StringSession is full account access: never print it, and
  never commit any secret.
- **The live tier spends the real account's rate budget.** `GRAMSCOPE_LIVE=1
  npm run test:live` makes real MTProto calls; a fan-out over
  `channels.getFullChannel` floods after about 20 calls in 5 seconds and
  teleproto absorbs the wait by sleeping, so a stalled request is the symptom.
  Read the measurements already recorded on the card rather than re-probing.
- **The ChatGPT connector caches its tool list at install time.** After any
  change to tool names, descriptions or schemas, reconnect it before testing, or
  the old list is what gets exercised.
- **`npm run build` rewrites `tsconfig.json`.** Restore the file rather than
  committing that churn.
- **Formatting is not enforced by `npm run lint`.** Run prettier on the files
  you edited, never over a directory: the repository is not prettier-clean and a
  directory-wide run buries the change in unrelated reformatting.

## Gates

`npm test`, `npm run typecheck` and `npm run lint` before every commit;
`npm run build` before a push. The live tier is required whenever peer
resolution, pagination or the client boundary changed.
