#!/usr/bin/env bash
set -euo pipefail

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
pause() { read -r -p "Press Enter when done... " _; }

cat <<'INTRO'
GramScope setup.

This walks through the accounts only you can create. Nothing here is stored in
the repository: secrets go into .env.local (gitignored) and Vercel.
INTRO

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
cat > .env.local <<ENVFILE
TELEGRAM_API_ID=${TELEGRAM_API_ID}
TELEGRAM_API_HASH=${TELEGRAM_API_HASH}
TELEGRAM_SESSION=
WORKOS_ISSUER=${WORKOS_ISSUER}
WORKOS_JWKS_URL=${WORKOS_JWKS_URL}
OWNER_USER_ID=${OWNER_USER_ID}
MCP_RESOURCE_URL=
ENVFILE
chmod 600 .env.local
echo "Wrote .env.local (chmod 600, gitignored)."
echo
echo "Now run:  npm run telegram:login"
echo "Then paste the printed session string into TELEGRAM_SESSION in .env.local."
pause

step "5/5  Vercel"
cat <<'TXT'
Deploy, then set MCP_RESOURCE_URL to the deployed origin + /api/mcp and push
every variable to Vercel:

  vercel link
  vercel deploy --prod
  for v in TELEGRAM_API_ID TELEGRAM_API_HASH TELEGRAM_SESSION \
           WORKOS_ISSUER WORKOS_JWKS_URL OWNER_USER_ID MCP_RESOURCE_URL; do
    vercel env add "$v" production
  done
  vercel deploy --prod

Finally, in ChatGPT: Settings -> Connectors -> add a custom connector pointing
at https://<your-deployment>/api/mcp, choose OAuth, and paste the WorkOS Connect
client id and secret.
TXT
echo "Setup walkthrough complete."
