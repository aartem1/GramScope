# GramScope operations runbook

How GramScope is deployed, updated, verified and repaired. Written to be
executed by an agent with access to the owner's Vercel project and VPS, so
every procedure is a command with an expected result rather than a
description.

The architecture this implements is
[`docs/superpowers/specs/2026-09-03-telegram-worker-split-design.md`](superpowers/specs/2026-09-03-telegram-worker-split-design.md).
The invariants that must never be broken are in [`AGENTS.md`](../AGENTS.md).
Read those before acting.

## 1. Implementation status

As of 1.6.0 (2026-09-03) both halves are in production. The VPS worker holds
the single Telegram session and serves `/rpc`, `/media`, and `/health` over
mTLS. Vercel owns MCP, OAuth, media capability tokens, and byte proxying, and
holds no Telegram credentials. ChatGPT has exercised the connector against this
layout without a reconnect.

Operate the system with `./scripts/gramscope` (`doctor`, `status`, `install`,
`update`, `login`, `configure`, `rollback`). `provision.sh` and the two-session
login/rotation scripts are gone. Telegram login on the VPS is
`./scripts/gramscope login` / `npm run telegram:login:worker`.

`doctor` accepts 1–2 Telegram authorizations: the VPS worker alone, or the
worker plus one phone client. Three or more usually means a leftover desktop
or second GramScope session and still fails the check. Do not start a second
worker or any in-process Telegram client against the same session while
production is up. There is no live Telegram unit suite.

Worker environment variables validated by `loadWorkerConfig`:

```text
TELEGRAM_API_ID
TELEGRAM_API_HASH
TELEGRAM_SESSION
TELEGRAM_WORKER_TOKEN
TELEGRAM_WORKER_HOST              optional; default 0.0.0.0
TELEGRAM_WORKER_PORT
TELEGRAM_WORKER_CA_FILE
TELEGRAM_WORKER_SERVER_CERT_FILE
TELEGRAM_WORKER_SERVER_KEY_FILE
GRAMSCOPE_REVISION
```

Install the systemd unit from `deploy/gramscope-worker.service` during
`./scripts/gramscope install`. §4–§8 describe the running system.

## 2. Architecture

```text
ChatGPT connector ─┐
Grok bot         ─┴─► https://<vercel-app>/api/mcp        (OAuth, WorkOS)
                          │
                          │  mutual TLS over IP, private CA
                          ▼
                     VPS worker :<port>   ── one MTProto connection ──► Telegram
                          ▲
media links ─► /api/media/... (Vercel verifies token, proxies bytes)
```

Vercel owns the MCP protocol, tool schemas, OAuth verification, media
capability tokens, and byte proxying. It holds no Telegram credentials.

The VPS worker owns the Telegram session, all Telegram operations, and media
processing. It is a single always-on process holding exactly one MTProto
connection, which is what makes parallel main-DC use impossible.

### Where each secret lives

Vercel environment only: `WORKOS_ISSUER`, `WORKOS_JWKS_URL`, `OWNER_USER_ID`,
`MCP_RESOURCE_URL`, `MEDIA_TOKEN_SECRET`, `TELEGRAM_WORKER_URL`,
`TELEGRAM_WORKER_TOKEN`, `TELEGRAM_WORKER_CA`, `TELEGRAM_WORKER_CLIENT_CERT`,
`TELEGRAM_WORKER_CLIENT_KEY`.

VPS only: `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION`,
`TELEGRAM_WORKER_TOKEN`, and the server certificate and key.

Nowhere else. In particular `TELEGRAM_SESSION` must never appear in Vercel, in
`.env.local`, or in this repository.

### What is deliberately not in git

The VPS address and port, all TLS material, and every secret. The repository is
private, but addresses and keys still stay out of it.

An agent reaches the VPS through an SSH alias, not a literal address. The owner
keeps this in `~/.ssh/config`:

```sshconfig
Host gramscope-worker
    HostName <vps-address>
    User <login>
    IdentityFile ~/.ssh/<key>
```

Every command below uses `gramscope-worker`. If the alias is missing, ask the
owner for it instead of putting an address into a file.

## 3. Access an agent needs

- Vercel: the `vercel` CLI logged in, with the project linked. `.vercel/` is
  gitignored and already present locally; confirm with `npx vercel project ls`.
- GitHub: `origin` is `git@github.com:aartem1/GramScope.git`, private. Vercel
  deploys from `main`, so pushing to `main` deploys the Vercel half.
- VPS: SSH via the `gramscope-worker` alias, with `sudo` for `systemctl`.
- Nothing else. The agent never needs the Telegram session string; it is
  created on the VPS and stays there.

### The gramscope CLI

Every procedure below has a one-command form. Run it locally; the tool drives
the VPS over SSH itself, so there is no step where you ssh in and continue by
hand.

```bash
./scripts/gramscope doctor            # check everything, change nothing
./scripts/gramscope install           # first-time setup, resumable
./scripts/gramscope update            # deploy current revision to both halves
./scripts/gramscope status            # what is running where
./scripts/gramscope configure <what>  # one scoped change
./scripts/gramscope login             # create or replace the Telegram session
./scripts/gramscope rollback
./scripts/gramscope migrate           # one-time cutover from the old layout
```

Useful flags: `--dry-run` prints the plan without applying it, `--yes` runs
unattended with no prompts, `--json` emits machine-readable output from
`doctor` and `status`.

Every command is idempotent and derives its state from the hosts rather than
from a saved file, so re-running after a failure is always safe and resumes
where it stopped.

The manual commands in the sections below are kept for two reasons: they
document what the tool actually does, and they are the fallback when the tool
itself is broken. Prefer the tool. Its design is spec §21.

## 4. One-time setup

`./scripts/gramscope install` performs all of §4. Run it once, or after a total
VPS rebuild. The steps below are what it does.

Delivered by spec subtasks 3 and 4.

### 4.1 Worker host

The service user comes first, because §4.2 grants it read access to the
server key.

```bash
sudo adduser --system --group --home /opt/gramscope gramscope
sudo install -d -m 755 -o gramscope -g gramscope /opt/gramscope
```

The `gramscope` user needs its own read-only access to GitHub, because §5.3
runs `git fetch` as that user on every deploy. Generate a key, register it as a
read-only deploy key on the repository, then clone:

```bash
sudo -u gramscope ssh-keygen -t ed25519 -N '' \
  -f /opt/gramscope/.ssh/id_ed25519
sudo -u gramscope cat /opt/gramscope/.ssh/id_ed25519.pub
# Add this as a read-only deploy key: GitHub → repo → Settings → Deploy keys
sudo -u gramscope git clone git@github.com:aartem1/GramScope.git /opt/gramscope
```

Node 20 or newer must be present. `sharp` and `ffmpeg-static` install glibc
binaries from npm, so Debian and Ubuntu work directly; a musl host such as
Alpine is unsupported.

### 4.2 Private certificate authority

There is no domain, so the server certificate is bound to the VPS IP address
through a SAN. Requires OpenSSL 1.1.1 or newer.

Run the whole block in a root shell (`sudo -i bash`): the directory is mode
700, so a non-root shell cannot even enter it, and `<(...)` process
substitution requires bash.

```bash
install -d -m 700 /etc/gramscope/tls
cd /etc/gramscope/tls
VPS_IP=<vps-address>

# Root CA, ten years.
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 \
  -sha256 -days 3650 -nodes -keyout ca.key -out ca.crt \
  -subj "/CN=GramScope Worker CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"

# Server certificate, bound to the IP.
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -sha256 -nodes \
  -keyout worker.key -out worker.csr -subj "/CN=gramscope-worker"
openssl x509 -req -in worker.csr -CA ca.crt -CAkey ca.key \
  -CAcreateserial -days 3650 -sha256 -out worker.crt \
  -extfile <(printf "subjectAltName=IP:%s,IP:127.0.0.1\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n" "$VPS_IP")

# Client certificate for Vercel.
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -sha256 -nodes \
  -keyout vercel.key -out vercel.csr -subj "/CN=gramscope-vercel"
openssl x509 -req -in vercel.csr -CA ca.crt -CAkey ca.key \
  -CAcreateserial -days 3650 -sha256 -out vercel.crt \
  -extfile <(printf "keyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n")

rm -f worker.csr vercel.csr
chown root:gramscope worker.key ca.crt worker.crt
chmod 640 worker.key
chmod 644 ca.crt worker.crt
```

Verify the IP SAN landed, because a missing SAN fails only at connection time:

```bash
openssl x509 -in /etc/gramscope/tls/worker.crt -noout -text \
  | grep -A1 "Subject Alternative Name"
# expect: IP Address:<vps-address>, IP Address:127.0.0.1
```

`127.0.0.1` is in the SAN so a health check run on the VPS itself validates
against the same certificate. Without it every local check would fail on
identity rather than on the thing being checked.

Keep `ca.key` and move it off the VPS or to root-only storage after issuing;
it is needed only to issue new client certificates.

### 4.3 Worker environment file

Root-owned, mode 600. systemd reads it before dropping privileges.

```bash
sudo install -d -m 700 /etc/gramscope
sudo install -m 600 /dev/null /etc/gramscope/worker.env
sudo tee /etc/gramscope/worker.env >/dev/null <<'EOF'
TELEGRAM_API_ID=
TELEGRAM_API_HASH=
TELEGRAM_SESSION=
TELEGRAM_WORKER_TOKEN=
TELEGRAM_WORKER_PORT=
TELEGRAM_WORKER_CA_FILE=/etc/gramscope/tls/ca.crt
TELEGRAM_WORKER_SERVER_CERT_FILE=/etc/gramscope/tls/worker.crt
TELEGRAM_WORKER_SERVER_KEY_FILE=/etc/gramscope/tls/worker.key
GRAMSCOPE_REVISION=
EOF
sudo chmod 600 /etc/gramscope/worker.env
```

Fill in `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_WORKER_PORT`, and
the three `TELEGRAM_WORKER_*_FILE` paths (adjust only if TLS files live
elsewhere). `TELEGRAM_SESSION` is written by §4.4. `GRAMSCOPE_REVISION` is
set on each deploy to the checked-out git sha (`./scripts/gramscope update`).
Generate the bearer token in
place, so its value never reaches the terminal or the shell history:

```bash
sudo sh -c 'sed -i "s|^TELEGRAM_WORKER_TOKEN=.*|TELEGRAM_WORKER_TOKEN=$(openssl rand -base64 32)|" /etc/gramscope/worker.env'
```

§4.6 copies the same value to Vercel without displaying it.

### 4.4 Telegram login

The session is created where it will be used and never transits another
machine.

```bash
ssh gramscope-worker
cd /opt/gramscope
sudo npm run telegram:login:worker
```

Telegram sends one login code. The script writes `TELEGRAM_SESSION` into
`/etc/gramscope/worker.env` without printing it, which is why it runs as root.
The npm script loads credentials from the same file via
`node --env-file=/etc/gramscope/worker.env`; override the write target in
tests with `--write-env <path>` only.

Confirm afterwards in Telegram under Settings → Devices: the GramScope worker
should be present, optionally next to one phone. Extra desktops or a second
GramScope session must be terminated there.

### 4.5 systemd unit

Install from the repository unit file (paths and env names match
`loadWorkerConfig`):

```bash
sudo cp /opt/gramscope/deploy/gramscope-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gramscope-worker
```

Or create it directly:

```bash
sudo tee /etc/systemd/system/gramscope-worker.service >/dev/null <<'EOF'
[Unit]
Description=GramScope Telegram worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=gramscope
Group=gramscope
WorkingDirectory=/opt/gramscope
EnvironmentFile=/etc/gramscope/worker.env
ExecStart=/usr/bin/node /opt/gramscope/dist/worker/worker/index.js
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/opt/gramscope
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now gramscope-worker
```

`PrivateTmp` matters: `src/media/materializer.ts` and
`src/media/ffmpeg-processor.ts` create video and frame files under the platform
temporary directory, and they must not be visible to anything else on the host.

Open the port in the host firewall. Vercel egress addresses are dynamic and
cannot be allowlisted; the TLS handshake is what rejects everyone else.

### 4.6 Vercel environment

Pipe every value straight from the VPS into `vercel env add` over stdin, so no
secret is ever printed, pasted, or left in shell history. Run locally, with the
project linked. `vercel env add` cannot overwrite, so remove first.

```bash
publish() {  # publish <vercel-var> <file-under-/etc/gramscope/tls>
  npx vercel env rm "$1" production --yes 2>/dev/null || true
  ssh gramscope-worker "sudo openssl base64 -A -in /etc/gramscope/tls/$2" \
    | npx vercel env add "$1" production
}

publish TELEGRAM_WORKER_CA          ca.crt
publish TELEGRAM_WORKER_CLIENT_CERT vercel.crt
publish TELEGRAM_WORKER_CLIENT_KEY  vercel.key
```

The bearer token comes from the worker environment file the same way:

```bash
npx vercel env rm TELEGRAM_WORKER_TOKEN production --yes 2>/dev/null || true
ssh gramscope-worker \
  "sudo sed -n 's|^TELEGRAM_WORKER_TOKEN=||p' /etc/gramscope/worker.env" \
  | npx vercel env add TELEGRAM_WORKER_TOKEN production
```

`TELEGRAM_WORKER_URL` is not secret but is not in git either; add it the same
way with `printf '%s' "https://<vps-address>:<port>"` as the source.

Then remove what Vercel must no longer hold:

```bash
npx vercel env rm TELEGRAM_SESSION production --yes
npx vercel env rm TELEGRAM_API_ID production --yes
npx vercel env rm TELEGRAM_API_HASH production --yes
```

Set the function region close to the VPS region in the Vercel project settings.
Every invocation pays one TLS handshake to the worker.

## 5. Deploying a change

`./scripts/gramscope update` performs all of §5 in the correct order. The steps
below are what it does.

Delivered by spec subtasks 4 and 5. Both halves live in this repository, so a
change can touch either or both.

### 5.1 Before anything

```bash
npm test && npm run typecheck && npm run lint && npm run build && npm run build:worker
```

All four must pass. The unit suite includes the golden `tools/list` fixture; if
that test fails, the MCP surface changed and the change must not ship until
the owner approves it, because both connectors would need reconnecting.

### 5.2 Ordering

The two halves are deployed separately and are briefly on different revisions,
so one release must never require both at once.

When a change **adds** an operation or a field, deploy the worker first. Vercel
then starts calling something that already exists.

When a change **removes or renames** an operation, deploy Vercel first, then
the worker. The worker keeps serving the old name until nothing calls it.

A change that both adds and removes must be split across two releases.

### 5.3 Worker

```bash
ssh gramscope-worker
cd /opt/gramscope
sudo -u gramscope git fetch origin
sudo -u gramscope git checkout <sha-or-main>
sudo -u gramscope npm ci
sudo -u gramscope npm run build:worker
sudo -u gramscope npm prune --omit=dev
sudo systemctl restart gramscope-worker
systemctl is-active gramscope-worker    # expect: active
```

`npm ci` installs dev dependencies because `tsc` is needed to build; the prune
afterwards removes them. `sharp` and `ffmpeg-static` are runtime dependencies
and survive it.

Record the deployed revision — `/health` reports it, so it is always possible
to see what is actually running rather than what was intended.

### 5.4 Vercel

Pushing to `main` deploys, because the project is connected to GitHub:

```bash
git push origin main
npx vercel ls --prod        # confirm the new deployment is READY
```

### 5.5 Verify

The worker is healthy and connected to Telegram. Run this on the VPS, after
`ssh gramscope-worker`, so no secret crosses the local shell:

```bash
sudo bash -c 'set -a; . /etc/gramscope/worker.env; set +a
  curl -sS --cert /etc/gramscope/tls/vercel.crt \
    --key /etc/gramscope/tls/vercel.key \
    --cacert /etc/gramscope/tls/ca.crt \
    -H "authorization: Bearer $TELEGRAM_WORKER_TOKEN" \
    "https://127.0.0.1:$TELEGRAM_WORKER_PORT/health"'
# expect: {"uptimeSeconds":...,"revision":"<sha>","telegram":{"connected":true,"sessionFingerprint":"...","authorizationCount":1|2,"lastErrorClass":null}}
```

`./scripts/gramscope doctor` does this and everything else in this section,
and additionally fails when the account has more than one active Telegram
authorization — the one condition that predicts the failure this architecture
exists to prevent. Read its output rather than only its exit code: a worker can
be up and serving while Telegram is disconnected.

The MCP endpoint still challenges unauthenticated callers:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' "$MCP_RESOURCE_URL"
# expect: 401
```

Then exercise one read-only tool from the ChatGPT connector without
reconnecting it. That is the only check that covers the whole chain, including
OAuth and the golden tool surface.

### 5.6 Rollback

Vercel:

```bash
npx vercel rollback        # or promote a specific previous deployment
```

Worker: the same procedure as §5.3 against the previous revision. Note the
ordering rule from §5.2 applies in reverse when rolling back.

## 6. Recovery

### 6.1 Worker unreachable

Tools return `UPSTREAM_UNAVAILABLE`. Read-only calls are safe to retry;
state-changing calls are not retried automatically and may or may not have
applied.

```bash
ssh gramscope-worker "systemctl status gramscope-worker --no-pager -l"
ssh gramscope-worker "sudo journalctl -u gramscope-worker -n 200 --no-pager"
```

A restart loop with a healthy configuration usually means the environment file
is missing a variable; the worker refuses to start rather than run degraded.

### 6.2 Telegram session destroyed

Symptom: every tool returns `AUTH_REQUIRED`, and `/health` reports the auth
key as dead. The worker stays up on purpose so the cause is readable.

This should not happen under the current architecture. Before re-logging in,
find the second connection, because a new session will be destroyed the same
way: check for a stray `node dist/worker/worker/index.js`, a second host with
a copy of the environment file, and the device list in Telegram.

Then:

```bash
./scripts/gramscope login
```

By hand, if the tool is unavailable:

```bash
ssh gramscope-worker
cd /opt/gramscope
sudo npm run telegram:login:worker
sudo systemctl restart gramscope-worker
```

No Vercel change and no redeploy is involved.

Afterwards run `./scripts/gramscope doctor`. Authorization count may be 1
(worker only) or 2 (worker plus phone); three or more means leftover sessions
that can destroy the replacement key:

```bash
./scripts/gramscope doctor
```

### 6.3 TLS failure

A certificate or key mismatch looks exactly like an outage:
`UPSTREAM_UNAVAILABLE` on every call, and the worker's journal shows handshake
failures. This fails closed by design.

First establish whether the channel works at all, independently of Vercel, by
running the §5.5 health check on the VPS.

If it succeeds there but Vercel still fails, the base64 values in Vercel env
are wrong or truncated; re-publish them per §4.6. A truncated key is the usual
cause and looks identical to a wrong one.

If it fails on the VPS too, the server certificate or its IP SAN is wrong;
reissue per §4.2 and restart the service.

Certificates are valid ten years. Reissuing the client pair does not require
touching the server or the session.

### 6.4 Bad Vercel deployment

Roll back per §5.6. OAuth configuration is unaffected by a rollback, so
connectors do not need to be reconnected.

## 7. Diagnostics

Start with `./scripts/gramscope doctor`, which checks every link in the chain
and names the fix for each failure, and `./scripts/gramscope status` for what
is running where. Both accept `--json`. The sources below are what they read.

Worker: `/health` for state, `journalctl -u gramscope-worker` for history. The
worker logs tool-level lines with operation name, status and duration, and no
payloads.

Vercel: `npx vercel logs <deployment-url>` for function logs. Media route paths
are never logged because the path contains a bearer capability.

Telegram: the device list under Settings → Devices is the ground truth.
Expect the GramScope worker and at most one phone; extra desktops or a second
GramScope session are not normal.

## 8. Routine maintenance

Dependency and Node upgrades follow §5: test locally, deploy the worker,
deploy Vercel. `sharp` and `ffmpeg-static` are the only native dependencies
and are the ones most likely to need a rebuild after a Node major upgrade;
`npm ci` on the VPS handles that.

Rotating `MEDIA_TOKEN_SECRET` immediately invalidates every outstanding media
link and is a Vercel-only change. Rotating `TELEGRAM_WORKER_TOKEN` requires
updating both `/etc/gramscope/worker.env` and Vercel, worker first.

There is nothing to rotate on a schedule. The session does not expire on its
own, and certificates are valid for ten years.
