# GramScope Telegram worker split — design

Task card: `docs/superpowers/tasks/gramscope-mcp.md`. Branch: `main`, following
the owner's repository-wide decision to work directly on `main`. Target
release: `1.6.0`.

Supersedes the two-session doctrine introduced on 2026-09-02 (commits `570ea1a`
and `7ec7ea2`) and recorded in README "Important operating rules". That doctrine
reduced the frequency of auth-key destruction; it could not eliminate it,
because the coordination it relies on does not exist between Vercel instances.

## 1. Problem

Telegram destroys the account's auth key when one authorized session is used by
two parallel main-DC connections. The behaviour is documented in
[Telegram error handling](https://core.telegram.org/api/errors):

> An exception to this is the `AUTH_KEY_DUPLICATED` error, which is only
> emitted if any of the non-media DC detects that an authorized session is
> sending requests in parallel from two separate TCP connections, **from the
> same or different IP addresses**.

Two facts follow, and both contradict the assumptions currently written into
the code and the README.

First, the constraint is not about IP addresses. `src/telegram/client.ts:71-77`,
`scripts/telegram-session.ts:8-11` and README lines 94-104 describe the failure
as "the same session mounted in two places" or "two different IP addresses".
Same-IP parallelism destroys the key just as reliably, so no egress-shaping
measure — a fixed-IP SOCKS5 proxy, an MTProxy, Vercel Secure Compute — can fix
it. Only media DCs are exempt from the restriction.

Second, the permitted concurrency is exactly one main session per auth key
unless the server advertises `tmp_sessions > 1`, which is granted at Telegram's
discretion and cannot be requested. The safe assumption is one.

GramScope currently violates this from three independent directions:

- ChatGPT and Grok are two MCP clients calling one `/api/mcp`; Vercel serves
  them from separate instances that share `TELEGRAM_SESSION`;
- `/api/media/[token]` and `/api/media/view/[token]` are separate Vercel
  functions, so a media fetch runs in a different instance from the MCP call
  that issued the link, even for a single consumer;
- one consumer alone produces overlap through parallel tool calls, parallel
  link fetches, and client retries that race a still-running request.

The lease counter in `acquireClient`/`releaseClient`
(`src/telegram/client.ts:210-251`) coordinates only calls inside one isolate.
Nothing coordinates isolates, and nothing can, without shared state.

The cost of each violation is not a failed request. It is a permanently
destroyed auth key requiring an interactive re-login, so the failure rate that
matters is per-month, not per-request.

## 2. Required outcome

Move every Telegram operation into one always-on process on the owner's VPS
that holds exactly one MTProto connection. Vercel keeps the MCP protocol and
OAuth and becomes stateless with respect to Telegram.

Parallel main-DC use then becomes structurally impossible rather than
improbable: there is one process, one session, and one connection, and the
existing in-process lease counter is sufficient to serialize it.

**The MCP surface must not change.** The owner requires that the ChatGPT
connector and the Grok bot keep working without being reconnected or
reauthorized. That makes the following invariant part of the acceptance
criteria, not a preference:

- the endpoint stays `/api/mcp`; no per-consumer endpoints are introduced;
- `MCP_RESOURCE_URL`, the WorkOS issuer, the audience and
  `/.well-known/oauth-protected-resource` are unchanged, so existing tokens
  keep validating;
- the `tools/list` payload — names, titles, descriptions, `inputSchema`,
  `outputSchema`, `annotations` — is byte-identical before and after;
- `MEDIA_TOKEN_SECRET` is not rotated, so links already issued keep working
  across the cutover.

## 3. Scope

In scope:

- an operation registry that names every domain call a tool can make;
- a long-lived worker process hosting that registry plus media byte delivery;
- mutual-TLS transport between Vercel and the worker over a bare IP address,
  with a private certificate authority;
- server-to-server authorization independent of the owner's OAuth session;
- media streaming proxied through the existing Vercel routes, with Range and
  cancellation preserved;
- a persistent MTProto connection with reconnection and health reporting;
- removal of the local/production session split and its tooling;
- systemd deployment, including hardening directives and log handling;
- one CLI that installs, updates, configures and diagnoses both halves,
  usable unattended, replacing `scripts/provision.sh`.

Out of scope:

- any change to tool names, schemas, descriptions or annotations;
- a public hostname or publicly trusted certificate for the VPS;
- direct media delivery from the VPS to ChatGPT;
- distributed locking, session pools, Redis, or any shared store;
- moving OAuth verification or media token issuance off Vercel;
- new Telegram capabilities, tools, or media representations.

## 4. Design principles

**One process owns the session.** The auth key exists in exactly one place: a
file on the VPS readable only by the worker's service user. It is never an
environment variable on Vercel, never in `.env.local`, and never copied.

**The seam is a domain operation, not a Telegram request.** The wire carries
one call per tool invocation. Anything finer-grained multiplies internet round
trips by the fan-out factor.

**Vercel owns the contract; the worker owns Telegram.** Tool schemas, OAuth,
and capability tokens stay on Vercel so that a worker deployment can never
alter what a connector sees. The worker exposes a fixed operation set and never
accepts a raw TL request.

**Errors keep their meaning across the wire.** `GramScopeError` is serialized
structurally and rehydrated. A rate limit must not degrade into a generic
upstream failure, because `retry_after_seconds` is the difference between a
usable and an unusable answer.

**Transport authentication is cryptographic, not secret-based.** A shared
bearer token protects nothing if the channel can be established by anyone. The
channel itself requires a client certificate.

## 5. Where the seam goes

The chosen seam is the domain operation. Each tool currently reads as one call
into a domain module — `runTool("list_dialogs", () => listDialogs(input))` in
`src/mcp/tools/list-dialogs.ts:32` is representative of all twenty. Replacing
that domain function with a typed remote call is a mechanical substitution that
leaves the tool body, its schemas, and its logging untouched.

Two alternative seams were considered and rejected; §20 records why.

## 6. Component split

Vercel retains `app/`, `src/mcp/`, `src/schemas/`, `src/pagination.ts`,
`src/errors/taxonomy.ts`, the media token in `src/media/token.ts`, and the two
media routes reduced to proxies. It stops importing `teleproto`, `sharp` and
`ffmpeg-static`, which shrinks the function bundle and its cold start.

The worker takes `src/telegram/*` unchanged, `src/media/*` except `token.ts`,
`src/concurrency.ts`, and `src/errors/from-telegram.ts`.

`src/schemas/*` is the shared layer and stays importable by both sides. One
existing edge must be cut: `src/schemas/message.ts:2` imports
`../telegram/peer-id`. `peer-id.ts` is a pure module with no client dependency,
so it moves into the shared layer rather than to the worker.

## 7. Shared constants

Tool input schemas and descriptions embed limits that currently live in modules
destined for the worker: `MAX_SOURCES_PER_CALL` (`telegram/messages.ts`,
`telegram/source-selection.ts`), `MAX_CONTEXT` (`telegram/messages.ts`),
`MAX_MARK_READ_SOURCES` (`telegram/read-state.ts`), `MEDIA_TYPES`
(`telegram/message-slice.ts`), and the folder limits used in
`src/mcp/tools/manage-folder.ts:102`.

Because `telegram/messages.ts` imports `./client`, a tool schema transitively
reaches the MTProto client today. These constants move into a neutral
`src/limits.ts` imported by both sides, with values preserved exactly. A
changed value would alter a `.max()` bound or an interpolated description
string, which changes `tools/list` and forces a connector reconnect — the one
outcome the owner ruled out.

## 8. Operation registry and wire contract

A single module declares every operation as a name, a zod input schema, a zod
output schema, and a handler that is the existing domain function. The registry
is the only thing the worker will execute.

The transport is one endpoint:

```text
POST /rpc
  { "op": "list_dialogs", "input": { ... } }
  -> 200 { "ok": true,  "result": { ... } }
  -> 200 { "ok": false, "error": { "code", "message", "retryable",
                                   "retryAfterSeconds"? } }
```

A non-2xx status means the transport or the worker failed, never that the
operation failed. Operation failures are always `ok: false` with a taxonomy
code, so the two classes stay distinguishable on the Vercel side.

Input is validated twice, on both sides of the wire, from the same schema.
Output is validated on the worker before it is sent, so a shape regression is
caught where the data is produced.

Vercel calls it through a client whose per-operation signatures match the
domain functions being replaced, so tool bodies change by one import line.

## 9. Error propagation

`GramScopeError` carries `code`, `message`, `retryAfterSeconds` and `retryable`
(`src/errors/taxonomy.ts:41-62`). All four cross the wire and are reconstructed
into a `GramScopeError` on Vercel before `runTool` sees it, which keeps
`errorResult`, `errorCodeOf` and the log lines working unchanged.

An unknown code from the worker becomes `INTERNAL_ERROR` rather than being
trusted, so a worker on a newer revision cannot inject a code the Vercel side
does not know.

Worker unreachability is a new condition. It is added to `ERROR_CODES` as
`UPSTREAM_UNAVAILABLE` with `retryable: true`. It must **not** be added to
`MEDIA_RESULT_CODES` in `src/schemas/media.ts`, because that enum is part of
`getMediaResultSchema` and therefore part of `get_media`'s `outputSchema`;
extending it would change `tools/list`. Taxonomy errors travel in the text
content block only (`src/mcp/tool-result.ts:24-31`), so adding a code there has
no schema effect.

Retries are attempted only when no response byte was received and only for
operations whose tool carries `readOnlyHint: true`. The six state-changing
tools listed in `tests/tool-names.ts` are never retried automatically, because
`join_channel`, `mark_read` and `manage_folder` are not idempotent in a way
that survives a partial application.

## 10. Transport

The VPS has no domain name and no publicly trusted certificate, and needs
neither: its only client is Vercel. The channel uses a private CA.

Three certificates are generated once, on the VPS, and never leave it except
for the client pair:

- a root CA, kept offline after issuance;
- a server certificate whose `subjectAltName` is `IP:<vps-address>`, since
  there is no name to bind;
- a client certificate for Vercel.

The worker listens with `requestCert: true` and `rejectUnauthorized: true`, so
a connection without a certificate signed by the private CA is dropped during
the TLS handshake, before any request is parsed. `minVersion` is TLS 1.3, which
also keeps the handshake at one round trip. TLS session resumption is enabled
to cut the cost of the per-invocation handshake.

Node validates an IP-literal peer against the certificate's IP SAN, and SNI is
not sent for IP hosts, so no hostname needs to exist anywhere. Vercel dials
through an `undici.Agent` configured with the CA, client certificate and key;
the media proxy needs the same agent for streaming, so it is created once per
module.

The three PEM values reach Vercel as base64-encoded environment variables to
avoid newline handling differences. Certificate lifetime is ten years, which is
acceptable for a private CA with a single relying party, and rotation is
documented rather than automated.

The listener must be reachable from the public internet because Vercel egress
addresses are dynamic and cannot be allowlisted. A non-default port is used to
reduce scanner noise, not as a security measure.

## 11. Server-to-server authorization

Two independent layers, in this order.

The client certificate is the primary authorization: possession proves the
caller is the Vercel deployment. This is checked by the TLS stack.

A static bearer token in the `authorization` header is the second layer,
compared with `crypto.timingSafeEqual`. Its purpose is to survive a future
topology change in which TLS terminates somewhere unexpected. It is not the
primary control and must not be treated as one.

Request signing with a timestamp and nonce is deliberately omitted. Under TLS
1.3 with mutual authentication it prevents nothing that the channel does not
already prevent, and it is a correctness risk to implement.

The worker performs no owner authorization. Vercel is the only component that
sees an OAuth token, and it rejects everything that is not the configured owner
before an operation is dispatched (`src/mcp/auth.ts:49-55`). The worker's
authorization decision is exactly "is this my Vercel deployment".

## 12. Media delivery

Media bytes are proxied through Vercel. Without a publicly trusted certificate
the VPS cannot serve ChatGPT directly, and acquiring one is out of scope.

Token issuance and verification stay on Vercel. `MEDIA_TOKEN_SECRET` is not
shared with the worker, so a worker compromise cannot mint capability links.

The two routes become proxies. Each verifies the token exactly as it does now,
then requests bytes from the worker by claims:

```text
POST /media
  { "sourceId", "messageId", "representation", "range"? }
  -> 200 | 206 with the byte stream and content headers
```

The worker resolves the asset, refetches the message to refresh the file
reference, and either streams the original through `iterDownload` or
materializes the derivative. Vercel copies through the status, content type,
length, `Content-Range`, and its own `Content-Disposition`,
`Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`.
Range parsing stays on Vercel in `src/media/range.ts` so an unsatisfiable range
is rejected without touching Telegram.

Cancellation is propagated end to end: the incoming request's `AbortSignal`
aborts the undici request, whose disconnect aborts the worker's
`iterDownload`. Without this a client that closes its connection leaves the VPS
downloading a video to nothing.

Two existing mechanisms become meaningfully better on a long-lived process and
require no code change: the derivative cache in `src/media/cache.ts`, whose
30-minute TTL and 256 MiB ceiling currently apply to an isolate of
unpredictable lifetime, and `withVideoPermit`, which becomes a real global gate
of one concurrent video instead of one per isolate.

## 13. Connection lifecycle

`releaseClient` stops disconnecting. The connection is opened once at process
start and held; `leases` remains only as a concurrency accounting device, which
is what the existing overlapping-call tests already describe.

Added behaviour:

- reconnection with bounded exponential backoff when the socket drops;
- a periodic lightweight request to distinguish a live socket from an open but
  dead one, since a silently dead TCP connection is indistinguishable from an
  idle one;
- on `AUTH_KEY_*` or `SESSION_REVOKED`, the worker does not exit. It enters an
  unhealthy state, refuses operations with `AUTH_REQUIRED`, and reports the
  reason on `/health`. Exiting would produce a systemd restart loop that
  reconnects with a dead key and hides the cause.

`GET /health`, also behind mTLS, reports process uptime, the deployed git
revision, whether Telegram is connected, the session fingerprint from
`scripts/telegram-session.ts:12`, the number of active account authorizations,
and the last error class if any. It is the single place the owner checks when
something is wrong.

The authorization count comes from `account.getAuthorizations` on a cached
interval. It exists so a second session on the account is detected while it is
still harmless, which is the only available warning before the condition in §1
destroys the key. §21.4 makes `doctor` fail on any count other than one.

## 14. Worker process and deployment

One package, one `package.json`, a second TypeScript project
`tsconfig.worker.json` emitting `dist/worker`. The worker runs on plain Node
with no dev dependencies; `tsx` is not used in production. Next ignores
`worker/` because it is outside `app/`.

`sharp` and `ffmpeg-static` install from npm on the VPS. Both ship glibc
binaries, so a Debian or Ubuntu host works directly; a musl host would need
different builds and is treated as unsupported.

systemd owns the process: `Restart=always` with a short `RestartSec`, a
dedicated unprivileged service user, `EnvironmentFile` pointing at a
root-owned mode-600 file holding the Telegram credentials, session string and
bearer token, and `NoNewPrivileges`, `ProtectSystem=strict` and `PrivateTmp`.
`PrivateTmp` also isolates the media temporary files that
`src/media/materializer.ts` and `src/media/ffmpeg-processor.ts` create under
the platform temp directory. Logs go to journald.

The Telegram login runs on the VPS itself, so the session string is created
where it will be used and never transits another machine.
`scripts/create-telegram-session.ts` gains a `--target worker` mode, exposed as
`npm run telegram:login:worker`, which writes `TELEGRAM_SESSION` into the
mode-600 environment file without printing it. `--target local` and
`--target production` are removed along with the doctrine they served.

That script must run on a `--omit=dev` install, because the deploy procedure
prunes dev dependencies after building and `tsx` is one of them. It is
therefore compiled into the worker build output rather than executed through
`tsx`.

The Vercel function region is set close to the VPS region. Each invocation pays
one TLS handshake to the worker, roughly 50-80 ms at 20-30 ms RTT, which
replaces the 200-400 ms MTProto reconnect every invocation pays today.

## 15. Configuration

Vercel gains four variables and loses one:

```text
TELEGRAM_WORKER_URL          https://<vps-ip>:<port>
TELEGRAM_WORKER_TOKEN        shared bearer, second layer only
TELEGRAM_WORKER_CA           base64 PEM, private root CA
TELEGRAM_WORKER_CLIENT_CERT  base64 PEM, client certificate
TELEGRAM_WORKER_CLIENT_KEY   base64 PEM, client private key
```

`TELEGRAM_SESSION`, `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` are deleted from
Vercel. `WORKOS_*`, `OWNER_USER_ID`, `MCP_RESOURCE_URL` and
`MEDIA_TOKEN_SECRET` are unchanged, which is what keeps existing connectors
authorized.

The worker holds `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION`,
`TELEGRAM_WORKER_TOKEN`, its server certificate and key, and the CA.

`loadConfig` is split so each side validates only the variables it needs, and
neither can start while missing one. The resulting secret split is a security
improvement worth stating plainly: a full compromise of the Vercel deployment
yields the ability to call a bounded operation set, not the account.

While `TELEGRAM_WORKER_URL` is unset, the dispatcher runs the registry
in-process. That keeps the unit suite and the live suite working unchanged and
makes subtask 1 a no-op refactor.

## 16. Failure modes

Worker down or unreachable: read-only tools return `UPSTREAM_UNAVAILABLE` with
`retryable: true`; writers return it without an automatic retry. No tool hangs
for the full 60-second Vercel budget: the `/rpc` deadline is 50 seconds and the
media deadline 290, both below their route's `maxDuration`.

Session destroyed: every operation returns `AUTH_REQUIRED`, `/health` names the
cause, and recovery is one login on the VPS plus a service restart. No redeploy
of Vercel is involved, unlike today.

Vercel unable to present a certificate: the worker drops the handshake, and
Vercel reports `UPSTREAM_UNAVAILABLE`. A misconfigured certificate therefore
fails closed and looks identical to an outage, which is the correct bias.

Worker overloaded: `FANOUT_CONCURRENCY` already bounds MTProto parallelism at
eight per connection. A global cap on concurrently executing operations is
added so a burst cannot grow memory without bound; excess requests wait and
then fail with `UPSTREAM_UNAVAILABLE` rather than being queued indefinitely.

## 17. Verification and acceptance

The compatibility invariant is enforced mechanically, not by review. A golden
test serializes the complete `tools/list` payload from a real MCP server and
compares it against a committed fixture. Any drift in a name, description,
schema bound or annotation fails the suite. This is what makes "the connectors
do not need reconnecting" a checked property.

Unit coverage adds:

- registry completeness: every tool's domain call is a registered operation,
  and every operation is reachable from a tool;
- round-trip of each taxonomy error, including `retry_after_seconds`
  preservation and unknown-code downgrade to `INTERNAL_ERROR`;
- retry policy: read-only retried on connection failure, writers never, and
  nothing retried after a response has started;
- constant extraction: the values in `src/limits.ts` equal the values the
  moved modules used, asserted against the golden `tools/list`;
- media proxy header, status, Range and abort propagation against a fake
  worker;
- connection lifecycle: no disconnect between operations, reconnect after a
  drop, unhealthy state on a dead auth key, and health payload contents.

Integration coverage runs the worker in-process over a real TLS listener with a
throwaway private CA, asserting that a client without a certificate is rejected
at the handshake, that a wrong bearer token is rejected after it, and that a
valid pair round-trips an operation.

The CLI is covered against a fake shell, which is why §21.1 separates deciding
from executing. The suite asserts that each check maps the host states in
§21.3 to the right verdict; that every §21.4 drift case produces the intended
plan; that `--dry-run` applies nothing; that a plan interrupted at any step
re-derives the same remaining work on the next run; that `--yes` never prompts
and fails cleanly on a value it was not given; and that no code path can place
a secret in a process argument or in output. Ordering rules — §5.2 and the
`migrate` sequence in §21.5 — are asserted as plans, since running them for
real is a one-way operation.

Deployed acceptance, on the real VPS and the real Vercel project:

- all twenty tools exercised from the existing ChatGPT connector **without
  reconnecting it**, which is the primary acceptance gate;
- the same from the Grok bot, concurrently with the ChatGPT run, sustained long
  enough to have destroyed the key under the previous architecture;
- a media original, a contact sheet and a voice note fetched through the proxy,
  including one Range request and one aborted download;
- `account.getAuthorizations` inspected before and after to confirm exactly one
  GramScope session exists;
- worker killed mid-conversation to confirm `UPSTREAM_UNAVAILABLE` and clean
  recovery on restart.

`typecheck`, lint, the unit suite, the production build and the live suite must
pass before release.

## 18. Ordered implementation subtasks

1. **Neutral shared layer.** Extract `src/limits.ts`, move `peer-id.ts` out of
   `src/telegram/`, and add the golden `tools/list` fixture. Pure refactor; the
   fixture is generated from the current output so it locks in today's surface.
2. **Operation registry and in-process dispatcher.** Declare every operation,
   route tool bodies through the dispatcher, keep execution local. No behaviour
   change, suite stays green.
3. **Worker skeleton and channel.** `worker/` with `/rpc` and `/health`, mTLS
   with a private CA, bearer layer, systemd unit, build target. `/health`
   reports the deployed git revision and the authorization count. Adds
   `telegram:login:worker`. Verified by the integration suite and a manual call
   from a laptop with the client pair.
4. **Operations CLI.** The §21 framework — shell abstraction, step model, plan
   and apply, secret handling — and every command: `doctor`, `status`,
   `install`, `configure`, `login`, `update`, `rollback` and `migrate`, with
   unit tests over a fake shell. Fills in the corresponding sections of
   `docs/operations.md` and removes `provision.sh`. Landing this before the
   cutover means the cutover itself is performed by a tested tool rather than
   by hand.
5. **Remote dispatch.** Vercel switches to the remote dispatcher when
   `TELEGRAM_WORKER_URL` is set, with error mapping and the retry policy. First
   deployment where Telegram work happens on the VPS; performed by
   `gramscope migrate`, which subtask 4 delivered.
6. **Media.** Move `src/media/*` except `token.ts`, turn both routes into
   streaming proxies, wire Range and abort propagation.
7. **Persistent connection.** Stop disconnecting on release, add reconnection,
   liveness probing, unhealthy state and health reporting.
8. **Cleanup and release.** Delete `TELEGRAM_SESSION` from Vercel,
   `assert-session-isolation.ts`, `rotate-telegram-sessions.sh` and the
   two-session sections of README; rewrite the operating rules and setup docs;
   clear the implementation-status caveats in `docs/operations.md`; set
   versions to `1.6.0`; run deployed acceptance.

Subtasks 1-4 are safe to deploy at any point because they do not change what
runs in production. Subtask 5 is the cutover.

## 19. What this removes

The two-session doctrine disappears entirely. There is no local session versus
production session, no fingerprint comparison, no rotation script, and no
warning about `vercel env pull`. Local development points at the same worker
and therefore at the same single session, which is the configuration that was
previously impossible.

Live tests keep the in-process mode from §15 so they can drive Telegram
directly, and that mode is the only place a second session could appear. It
requires its own credentials and must not be run while the worker is serving.

## 20. Operational documentation

The owner intends to grant an agent access to Vercel and the VPS and have it
deploy and update both halves unattended. That makes the runbook part of the
deliverable, not documentation about it.

`docs/operations.md` is authoritative and must contain, for the target system:
the architecture map and which secret lives where; the access an agent needs;
one-time setup including certificate issuance, host bootstrap, systemd unit and
Telegram login; the deploy procedure with its ordering rule; verification with
expected output; rollback; and a recovery procedure per failure mode in §16.

Two rules keep it from drifting into fiction:

- every subtask that changes deployment, secrets, or recovery updates
  `docs/operations.md` in the same change, and the implementation-status
  section at its top is corrected in that same change;
- procedures are executable rather than prose wherever a command can express
  them. The CLI in §21 is that executable form, and the runbook calls it
  instead of restating what it does. Long shell fragments embedded in markdown
  are the form most likely to be wrong when an agent runs them blind, so they
  survive only as an explanation of what the tool performs and as a manual
  fallback.

`AGENTS.md` holds the invariants an agent must not break and is deliberately
short, because it is loaded into every agent session. It states the
consequences rather than only the rules: an agent that does not know why the
single session matters will eventually reason its way around the rule.

Host addresses, ports, TLS material and secrets stay out of the repository even
though it is private. The VPS is reached through an SSH alias
(`gramscope-worker`) that the owner defines locally, so no address appears in
git.

## 21. Installer and operations CLI

The runbook in §20 describes what must happen. One command-line tool performs
it, so that installing, updating, reconfiguring and diagnosing the two halves
never requires reading a procedure and retyping commands across two hosts.

Entry point `./scripts/gramscope`, a shim over TypeScript run through `tsx`.
TypeScript rather than bash because this tool orchestrates two hosts, compares
state, and must be unit tested; `scripts/provision.sh` already depends on `tsx`
for its atomic env writes, so no new dependency is introduced. `provision.sh`
is superseded and removed.

### 21.1 Plan and apply

The tool never executes a fixed script. Every unit of work is a step with an
id, a human title, a check that inspects reality, and an apply that changes it.
A check returns satisfied, actionable, or blocked with a reason.

`doctor` runs every check and changes nothing. `install` applies the steps that
are actionable, in order. `--dry-run` prints the plan without applying it.

Resumability comes from deriving state rather than recording it. There is no
install-state file, because a state file and reality diverge exactly when it
matters — after a partial failure. Re-running any command is safe by
construction.

Both hosts are reached through one shell interface with a local and an
SSH-backed implementation. Steps do not know which host they run on, and tests
inject a fake, so the whole decision surface is testable without a VPS.

### 21.2 Commands

- `doctor` — check everything, report each item with its fix, exit non-zero on
  any failure. `--json` for machine consumption.
- `install` — first-time setup of both halves, resumable, idempotent.
- `update` — deploy the current revision to both halves in the §5.2 order and
  verify.
- `configure <target>` — a single scoped change: rotate the worker token,
  rotate `MEDIA_TOKEN_SECRET`, change the port, reissue the client or server
  certificate, set the Vercel region.
- `login` — create or replace the Telegram session on the VPS.
- `status` — what is running where, with revisions and health.
- `rollback` — previous revision on either half.
- `migrate` — the one-time cutover described in §21.5.

Global flags: `--dry-run`, `--yes` for unattended runs, `--json`, `--host` to
override the SSH alias, `--verbose`.

`--yes` matters as much as the interactive flow: the owner intends to delegate
deployment to an agent, and a tool that can only be driven by a human answering
prompts cannot be delegated. Every value the tool needs is therefore also
accepted as a flag or an environment variable, and interactive prompting is the
fallback, not the mechanism.

### 21.3 What the checks cover

Local: Node version, a clean and pushed working tree, `vercel` CLI present and
authenticated, project linked, SSH alias resolving and connecting.

VPS preconditions: glibc rather than musl, Node 20 or newer, OpenSSL 1.1.1 or
newer, bash, systemd, clock skew within tolerance, free disk, and the listener
port reachable from outside. Clock skew is checked because it breaks TLS and
MTProto simultaneously and presents as an unrelated failure.

VPS state: service user, clone, deploy key usable (`git fetch --dry-run`), TLS
material present, server certificate SAN still covering the host's current
public address, environment file complete, session present, build output
present, unit installed and active, and `/health` reporting a live Telegram
connection.

Vercel state: every required variable present; the legacy `TELEGRAM_SESSION`,
`TELEGRAM_API_ID` and `TELEGRAM_API_HASH` absent; `TELEGRAM_WORKER_URL`
matching the actual address and port; the client certificate in Vercel matching
the CA on the VPS; the latest deployment ready; and `/api/mcp` answering 401
without a token.

Certificate and key agreement is verified by comparing fingerprints, never
values, following the `sessionFingerprint` pattern in
`scripts/telegram-session.ts:12`. The tool must be able to prove two secrets
match without being able to show either.

### 21.4 Drift the tool must recognize

These are the cases that produce a confusing failure if they are only found by
hand:

- the VPS public address changed, so the server certificate SAN no longer
  covers it — reissue, restart, and republish `TELEGRAM_WORKER_URL`;
- Vercel still holds Telegram credentials, meaning the deployment predates the
  split and needs `migrate`;
- the worker's revision differs from local `HEAD`, meaning `update` was not run
  or failed halfway;
- the worker is healthy but Telegram is disconnected, which is a session
  problem and not a deployment problem;
- **more than one active Telegram authorization exists.** `/health` reports the
  count from `account.getAuthorizations`, and `doctor` fails when it is not
  one. This is the only check that catches the original failure before it
  destroys the key rather than after, so it is required, not optional.

### 21.5 Migration from the current deployment

`migrate` performs the cutover once, in an order chosen so that a failure at
any point leaves a working system:

1. confirm the worker is installed, healthy and connected with its own session;
2. publish the worker variables to Vercel;
3. deploy the Vercel half with remote dispatch enabled;
4. verify the whole chain, including one real tool call;
5. only then remove `TELEGRAM_SESSION`, `TELEGRAM_API_ID` and
   `TELEGRAM_API_HASH` from Vercel and redeploy;
6. instruct the owner to terminate the now-unused Telegram authorizations in
   the device list, and verify the count reaches one.

Step 5 comes after verification on purpose: until the new path is proven, those
variables are what a rollback needs.

## 22. Repository hygiene

This change obsoletes a significant part of `scripts/`. Nothing may be left
behind that only makes sense under the old architecture, and nothing may be
deleted while it is still the only working way to do its job. The fate of each
item and the subtask that performs it:

`scripts/provision.sh` is deleted by subtask 4, which replaces it with the CLI.
Until then it is the only working installer and must survive.

`scripts/create-telegram-session.ts` is reworked by subtask 3 to a single
`--target worker` mode. The `local` and `production` targets go with the
doctrine that required them, and the script is compiled into the worker build
so it runs on a `--omit=dev` install.

`scripts/telegram-session.ts` is split rather than deleted.
`sessionFingerprint` survives because §21.3 compares secrets by fingerprint.
`publishProductionSession` is deleted: no Telegram session reaches Vercel
again. `parseLoginTarget` and `envTargetPath` are deleted with the targets they
parse. `readEnvKey` and `readEnvFileKey` move into the CLI. `runCaptured` and
`runWithStdin` become the local implementation of the CLI's shell interface —
the same stdin-only secret handling, in one place instead of two.

`scripts/assert-session-isolation.ts` and `scripts/rotate-telegram-sessions.sh`
are deleted by subtask 8. Both exist to manage two sessions, and there will be
one. Both are load-bearing until the cutover, so neither may be removed
earlier. The useful shape of the rotation script — verify, redeploy,
smoke-check — becomes `gramscope update`.

`scripts/env-file.ts` is kept. `upsertEnvFile` is how the CLI writes any dotenv
file atomically.

The `telegram:login:local`, `telegram:login:production`,
`telegram:assert-session-isolation` and `telegram:rotate-sessions` npm scripts
are removed by subtask 8. Subtask 3 adds `telegram:login:worker` and
`build:worker`.

`tests/telegram-session.test.ts` follows the module it covers.

`.env.example` loses the Telegram variables and the two-session commentary in
subtask 8, and README's setup and operating rules are rewritten there.

Historical specs and plans under `docs/superpowers/` are not rewritten. The
repository treats them as records of decisions valid at their time, so their
references to removed commands stay as they are.

The standing rule: a subtask that obsoletes something either deletes it or, if
it is still load-bearing, records the deferral in `docs/operations.md` §1. An
obsolete script left undocumented is worse than one left in place, because the
next agent cannot tell which of two commands is the real one.

## 23. Rejected alternatives

**Distributed lease in Redis with a session pool.** A pool of auth keys leased
atomically per request, with the lease TTL set above `maxDuration` so expiry
implies the holder is dead. Genuinely sound, and it was the recommended option
while staying on Vercel. Rejected because the owner has a VPS: it adds a hot-path
dependency and 30-40 ms per request to work around the absence of a stateful
process, which the VPS supplies directly.

**Static session partitioning per consumer and per function.** Separate
sessions for ChatGPT, Grok and media, selected by endpoint path and by a token
claim. Cheap and structurally sound between partitions, but it leaves
intra-partition overlap — parallel tool calls, parallel link fetches, retries —
unaddressed, and each remaining collision still destroys a key permanently. It
also requires new endpoints, which conflicts with the no-reconnect requirement.

**Fixed egress IP via SOCKS5 or MTProxy.** `teleproto` supports both
(`network/connection/TCPMTProxy.d.ts`). Rejected on the documented behaviour
quoted in §1: parallel main-DC connections destroy the key from the same IP as
readily as from different ones.

**RPC at the `withTelegram` level.** Rejected because a 25-source fan-out at
`FANOUT_CONCURRENCY` would become 25 or more internet round trips instead of
one, and because `withTelegram` hands its callback a live client object that
cannot be serialized.

**Proxying raw MCP JSON-RPC to the worker.** Simplest possible Vercel layer,
but Streamable HTTP means proxying SSE and `Mcp-Session-Id` correctly through a
serverless function, and it moves tool schemas onto the VPS so every
description change becomes a worker deployment. Rejected as a hazard to the
no-reconnect invariant.

**Moving the whole MCP server to the VPS.** Removes Vercel entirely, but the
VPS has no domain and no publicly trusted certificate, and ChatGPT connectors
require both. Rejected by the owner's stated constraint.

**Serving media directly from the VPS.** Would save Vercel bandwidth and remove
the 300-second route ceiling, but requires a publicly trusted certificate and
therefore a domain. Reconsider only if a domain is acquired later; the proxy
contract in §12 does not prevent it.

**Publicly trusted certificate via a tunnel.** Cloudflare Tunnel needs a
Cloudflare-managed domain for a stable hostname, and Tailscale Funnel is
documented as unsuitable for sustained high-bandwidth transfer, which media
streaming is. Both add a third-party dependency in the request path for no gain
over a private CA on a server-to-server channel.
