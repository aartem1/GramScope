#!/usr/bin/env bash
set -euo pipefail

# Resolve the repo root from this script's own location. Writing .env.local
# relative to $PWD put it wherever the wizard happened to be invoked from,
# where nothing reads it.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env.local"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
pause() { read -r -p "Press Enter when done... " _; }

cat <<'INTRO'
GramScope setup.

This walks through the accounts only you can create. Nothing here is stored in
the repository: secrets go into .env.local (gitignored) and Vercel.
INTRO

# Refuse to clobber an existing .env.local without being told to. It holds
# TELEGRAM_SESSION, which costs an interactive Telegram login to regenerate.
if [ -e "$ENV_FILE" ]; then
  echo
  echo "WARNING: $ENV_FILE already exists."
  echo "Continuing OVERWRITES it, including any TELEGRAM_SESSION it holds."
  echo "Regenerating that session requires another interactive Telegram login."
  read -r -p "Type 'overwrite' to replace it, anything else to abort: " CONFIRM
  if [ "$CONFIRM" != "overwrite" ]; then
    echo "Aborted. Nothing was changed."
    exit 1
  fi
fi

step "1/5  Dedicated Telegram account"
cat <<'TXT'
Register a SEPARATE Telegram account for GramScope, with its own phone number.
Do not use your personal account: the session string this setup produces grants
full access to whatever account you log in with.

Then subscribe it to a few source channels so there is something to read.
TXT
pause

step "2/5  Telegram API credentials"
cat <<'TXT'
Open https://my.telegram.org -> API development tools, logged in as the
dedicated account. Create an application and copy api_id and api_hash.
TXT
read -r -p "TELEGRAM_API_ID: " TELEGRAM_API_ID
read -r -s -p "TELEGRAM_API_HASH: " TELEGRAM_API_HASH; echo

step "3/5  WorkOS AuthKit"
cat <<'TXT'
Create a WorkOS account at https://dashboard.workos.com, then:
  - enable AuthKit and note your AuthKit domain (the OAuth issuer);
  - under Connect, create an OAuth client and copy its client id and secret;
  - keep that client id and secret for the ChatGPT connector form.

The issuer is the URL that serves /.well-known/oauth-authorization-server.
TXT
read -r -p "WORKOS_ISSUER (e.g. https://your-app.authkit.app): " WORKOS_ISSUER
read -r -p "WORKOS_JWKS_URL: " WORKOS_JWKS_URL
read -r -p "OWNER_USER_ID (your WorkOS user id, the token 'sub'): " OWNER_USER_ID

step "4/5  Telegram session string"
# Create the file restricted BEFORE any secret goes into it. Writing first and
# chmod-ing after leaves a window where it is group/other readable under a
# default umask.
umask 077
: > "$ENV_FILE"
chmod 600 "$ENV_FILE"
cat > "$ENV_FILE" <<ENVFILE
TELEGRAM_API_ID=${TELEGRAM_API_ID}
TELEGRAM_API_HASH=${TELEGRAM_API_HASH}
TELEGRAM_SESSION=
WORKOS_ISSUER=${WORKOS_ISSUER}
WORKOS_JWKS_URL=${WORKOS_JWKS_URL}
OWNER_USER_ID=${OWNER_USER_ID}
ENVFILE
echo "Wrote $ENV_FILE (chmod 600, gitignored)."
echo
echo "In a SECOND terminal, run:  npm run telegram:login"
echo "(this wizard is holding this terminal until you press Enter)"
echo
echo "That prints a session string. Paste it into TELEGRAM_SESSION in"
echo ".env.local. It grants full access to the account — treat it like a"
echo "password, and do not paste it anywhere else."
pause

step "5/5  Vercel"
cat <<'TXT'
Deploy once to learn the deployment URL:

  vercel link
  vercel deploy --prod

TXT
pause

# MCP_RESOURCE_URL is the audience every access token is checked against, and
# it is required — the server refuses to start without it, because an
# unchecked audience lets any other app in the same WorkOS environment in.
read -r -p "Deployment origin (e.g. https://gramscope.vercel.app): " DEPLOY_URL
DEPLOY_URL="${DEPLOY_URL%/}"
case "$DEPLOY_URL" in
  */api/mcp) MCP_RESOURCE_URL="$DEPLOY_URL" ;;
  *) MCP_RESOURCE_URL="$DEPLOY_URL/api/mcp" ;;
esac
printf 'MCP_RESOURCE_URL=%s\n' "$MCP_RESOURCE_URL" >> "$ENV_FILE"
echo "Set MCP_RESOURCE_URL=$MCP_RESOURCE_URL"
echo
cat <<'TXT'
Now push every variable to Vercel and redeploy:

  for v in TELEGRAM_API_ID TELEGRAM_API_HASH TELEGRAM_SESSION \
           WORKOS_ISSUER WORKOS_JWKS_URL OWNER_USER_ID MCP_RESOURCE_URL; do
    vercel env add "$v" production
  done
  vercel deploy --prod

In WorkOS, make sure the Connect client requests this same resource URL as its
audience; a token minted for anything else is rejected.

Finally, in ChatGPT: Settings -> Connectors -> add a custom connector pointing
at <your deployment>/api/mcp, choose OAuth, and paste the WorkOS Connect
client id and secret.
TXT
echo "Setup walkthrough complete."
