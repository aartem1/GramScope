#!/usr/bin/env bash
set -euo pipefail

# Resolve the repo root from this script's own location. Writing .env.local
# relative to $PWD put it wherever the wizard happened to be invoked from,
# where nothing reads it.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env.local"
cd "$ROOT"

# git  — Vercel builds from GitHub on push to main (the default; matches a
#        project created through Vercel's Git integration).
# cli  — deploy straight from this machine with the Vercel CLI.
# none — you handle deployment entirely yourself.
DEPLOY_MODE=git
case "${1:-}" in
  --deploy=cli)  DEPLOY_MODE=cli ;;
  --deploy=none|--skip-deploy) DEPLOY_MODE=none ;;
  "") ;;
  *) echo "unknown option: $1 (expected --deploy=cli or --deploy=none)"; exit 1 ;;
esac

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
note() { printf '\033[2m%s\033[0m\n' "$1"; }
ask()  { read -r -p "$1" "$2"; }
confirm() {
  local reply
  read -r -p "$1 [y/N] " reply
  [ "$reply" = "y" ] || [ "$reply" = "Y" ]
}

# Read a key's current value out of .env.local, empty if absent.
env_get() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | head -n 1
}

# Write a key through the tested upsert helper rather than appending blindly,
# so re-running the wizard updates values instead of duplicating them.
env_set() {
  # Value goes over stdin, never as an argument: arguments are visible to
  # anyone who can run `ps` on this machine.
  printf '%s' "$2" | npx --no-install tsx scripts/env-file.ts "$ENV_FILE" "$1"
}

# Everything entered is written to .env.local the moment it is answered, and
# that write is atomic, so an interrupt at any point keeps what you have
# already given. This reports what survived and how to pick up again.
REQUIRED_KEYS="TELEGRAM_API_ID TELEGRAM_API_HASH TELEGRAM_SESSION WORKOS_ISSUER WORKOS_JWKS_URL OWNER_USER_ID MCP_RESOURCE_URL"

summarise() {
  local have=() missing=() k
  for k in $REQUIRED_KEYS; do
    if [ -n "$(env_get "$k")" ]; then have+=("$k"); else missing+=("$k"); fi
  done
  echo
  if [ ${#have[@]} -gt 0 ]; then
    echo "Saved in $ENV_FILE:"
    for k in "${have[@]}"; do echo "  - $k"; done
  else
    echo "Nothing saved yet."
  fi
  if [ ${#missing[@]} -gt 0 ]; then
    echo "Still needed:"
    for k in "${missing[@]}"; do echo "  - $k"; done
  fi
}

on_interrupt() {
  # Restore default handling first, so a second Ctrl+C always gets out.
  trap - INT TERM
  echo
  echo "Interrupted."
  summarise
  echo
  echo "Nothing entered was lost. Re-run ./scripts/provision.sh to continue"
  echo "from here — it skips whatever is already set."
  exit 130
}
trap on_interrupt INT TERM

# Prompt only when the value is missing, so a re-run skips what is already done.
# $3 = "secret" suppresses echo.
ask_env() {
  local key="$1" prompt="$2" mode="${3:-}" current value
  current="$(env_get "$key")"
  if [ -n "$current" ]; then
    note "$key already set — keeping it."
    return 0
  fi
  if [ "$mode" = "secret" ]; then
    read -r -s -p "$prompt" value; echo
  else
    read -r -p "$prompt" value
  fi
  [ -n "$value" ] || { echo "A value is required."; exit 1; }
  env_set "$key" "$value"
}

cat <<'INTRO'
GramScope setup.

One pass, start to finish. Anything you have already provided is kept, so it is
safe to re-run this after a step fails.

Secrets go into .env.local (mode 600, gitignored) and into Vercel. Nothing is
written into the repository, and the Telegram session is never printed.
INTRO

# Create the file restricted BEFORE any secret goes into it. Writing first and
# chmod-ing after leaves a window where it is group/other readable.
umask 077
if [ ! -e "$ENV_FILE" ]; then
  : > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo
  echo "Created $ENV_FILE"
else
  chmod 600 "$ENV_FILE"
  echo
  note "Using existing $ENV_FILE — filling in only what is missing."
fi

# ---------------------------------------------------------------- Telegram ---
step "1/6  Dedicated Telegram account"
cat <<'TXT'
Use a SEPARATE Telegram account, with its own phone number. The session this
produces grants full access to whichever account you log into, so do not use
your personal one.

Subscribe it to a few channels now, otherwise the live tests have nothing to
read.
TXT
ask "Press Enter when the account is ready... " _

step "2/6  Telegram API credentials"
cat <<'TXT'
Open https://my.telegram.org while logged in AS THE DEDICATED ACCOUNT:
  API development tools -> create an application -> copy api_id and api_hash.
TXT
ask_env TELEGRAM_API_ID   "TELEGRAM_API_ID: "
ask_env TELEGRAM_API_HASH "TELEGRAM_API_HASH (hidden): " secret

step "3/6  Telegram login"
if [ -n "$(env_get TELEGRAM_SESSION)" ]; then
  note "TELEGRAM_SESSION already set — skipping login."
else
  cat <<'TXT'
Logging in now, in this terminal. Telegram will send a code to the account.
The resulting session is written straight into .env.local and is never shown.
TXT
  # Export only for the child process; the values stay out of the wizard's
  # own environment beyond this call.
  TELEGRAM_API_ID="$(env_get TELEGRAM_API_ID)" \
  TELEGRAM_API_HASH="$(env_get TELEGRAM_API_HASH)" \
    npx --no-install tsx scripts/create-telegram-session.ts --write-env "$ENV_FILE"
fi

# ------------------------------------------------------------------ Vercel ---
step "4/6  Deploy, to learn your address"
case "$DEPLOY_MODE" in
  git)
    cat <<'TXT'
Deploying through GitHub. The app builds without any environment variables, so
this first deploy exists only to assign the URL — it will not work yet.
TXT
    if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
      echo
      echo "Working tree has uncommitted changes. Vercel builds what is pushed,"
      echo "not what is on your disk, so commit or stash first."
      exit 1
    fi
    branch="$(git rev-parse --abbrev-ref HEAD)"
    if ! git diff --quiet "@{upstream}" 2>/dev/null; then
      echo
      echo "Branch '$branch' differs from its upstream. Push it before deploying:"
      echo "    git push origin $branch"
      exit 1
    fi
    cat <<'TXT'

In Vercel: New Project -> import this GitHub repository -> production branch
'main'. It detects Next.js on its own. Wait for the first build to finish.
TXT
    ask "Press Enter once the first deploy has finished... " _
    ask "Deployment origin (e.g. https://gramscope.vercel.app): " DEPLOY_URL
    ;;
  cli)
    if confirm "Run 'vercel link' and deploy from here?"; then
      vercel link
      vercel deploy --prod | tee /tmp/gramscope-deploy.log
      DEPLOY_URL="$(grep -oE 'https://[a-zA-Z0-9.-]+\.vercel\.app' /tmp/gramscope-deploy.log | tail -n 1 || true)"
      rm -f /tmp/gramscope-deploy.log
      if [ -n "${DEPLOY_URL:-}" ]; then
        echo
        echo "Detected deployment: $DEPLOY_URL"
        confirm "Use this address?" || DEPLOY_URL=""
      fi
    fi
    [ -n "${DEPLOY_URL:-}" ] || ask "Deployment origin: " DEPLOY_URL
    ;;
  none)
    note "Deploy handled by you."
    ask "Deployment origin (e.g. https://gramscope.vercel.app): " DEPLOY_URL
    ;;
esac

DEPLOY_URL="${DEPLOY_URL%/}"
[ -n "$DEPLOY_URL" ] || { echo "A deployment address is required."; exit 1; }
ORIGIN="$(printf '%s' "$DEPLOY_URL" | sed -E 's#(https?://[^/]+).*#\1#')"
case "$DEPLOY_URL" in
  */api/mcp) MCP_RESOURCE_URL="$DEPLOY_URL" ;;
  *)         MCP_RESOURCE_URL="$DEPLOY_URL/api/mcp" ;;
esac
env_set MCP_RESOURCE_URL "$MCP_RESOURCE_URL"
echo "MCP_RESOURCE_URL=$MCP_RESOURCE_URL"

# ------------------------------------------------------------------ WorkOS ---
step "5/6  WorkOS AuthKit"
cat <<TXT
Create an account at https://dashboard.workos.com, then open
Connect -> Configuration and do three things:

  1. Resource Indicators -> add EXACTLY this value:

         $MCP_RESOURCE_URL

     then open its "..." menu and choose "Set as default".
     This is what puts the right 'aud' in the token. Skip it and AuthKit
     issues a default environment audience, and every call fails with 401.

  2. Enable Client ID Metadata Document (CIMD) — how MCP clients identify
     themselves without pre-registering.

  3. Enable Dynamic Client Registration as a fallback for older clients.

Then collect the values below. The issuer is the AuthKit domain that serves
/.well-known/oauth-authorization-server; the JWKS URL is listed in that
document. Your user id appears under Users after you sign in to your own
AuthKit once.
TXT
ask_env WORKOS_ISSUER   "WORKOS_ISSUER (e.g. https://your-app.authkit.app): "
ask_env WORKOS_JWKS_URL "WORKOS_JWKS_URL: "
ask_env OWNER_USER_ID   "OWNER_USER_ID (your WorkOS user id, the token 'sub'): "

# ----------------------------------------------------------------- Publish ---
step "6/6  Publish configuration and redeploy"
cat <<'TXT'
The variables are pushed with the Vercel CLI rather than pasted into the
dashboard on purpose: `vercel env add` reads each value and sends it without
displaying it, so TELEGRAM_SESSION never appears on your screen.
TXT

if [ "$DEPLOY_MODE" = "none" ]; then
  note "Push the variables and redeploy yourself; they are all in $ENV_FILE."
elif confirm "Push all variables to Vercel production now?"; then
  if [ ! -d "$ROOT/.vercel" ]; then
    note "Linking this directory to your Vercel project first."
    vercel link
  fi
  for v in $REQUIRED_KEYS; do
    value="$(env_get "$v")"
    if [ -z "$value" ]; then
      echo "Missing $v — aborting before a half-configured deploy."
      exit 1
    fi
    # `vercel env add` does not replace an existing value, so remove first.
    vercel env rm "$v" production --yes >/dev/null 2>&1 || true
    printf '%s' "$value" | vercel env add "$v" production >/dev/null
    echo "  pushed $v"
  done

  cat <<'TXT'

Environment variables do NOT trigger a rebuild on their own. The running
deployment still has none of them, so it must be redeployed now — otherwise
every request keeps failing and it looks like the configuration did not take.
TXT
  if confirm "Redeploy production now?"; then
    if [ "$DEPLOY_MODE" = "git" ]; then
      # Rebuild the current production deployment rather than uploading from
      # this machine, so the Git integration stays the source of truth.
      vercel redeploy "$(vercel ls --prod 2>/dev/null | grep -oE 'https://[a-zA-Z0-9.-]+\.vercel\.app' | head -n 1)" 2>/dev/null \
        || note "Could not redeploy from here — press Redeploy in the Vercel dashboard."
    else
      vercel deploy --prod
    fi
  else
    note "Remember: press Redeploy in the Vercel dashboard before testing."
  fi
fi

summarise

cat <<TXT

Setup complete.

Verify the deployment:

  curl -s $ORIGIN/.well-known/oauth-protected-resource
  curl -s -o /dev/null -w '%{http_code}\n' $MCP_RESOURCE_URL

The metadata document must report "resource": "$MCP_RESOURCE_URL"
— the same string you registered in WorkOS — and the second call must be 401.

Run the live tests against the real account:

  GRAMSCOPE_LIVE=1 npm run test:live

Then in ChatGPT: Settings -> Connectors -> add a custom connector at

  $MCP_RESOURCE_URL

choose OAuth, and complete the sign-in. With CIMD enabled you should not need
a client id or secret; if the form insists, create one under
Dashboard -> Applications in WorkOS.

You should see exactly three tools: list_dialogs, list_folders, get_channel.
TXT
