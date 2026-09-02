#!/usr/bin/env bash
set -euo pipefail

# One-shot: separate production + local Telegram sessions, redeploy, verify.
# Interactive — Telegram will ask for ONE login code per session (two codes total).
# Do not run this while Telegram still rate-limits the account.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
note() { printf '\033[2m%s\033[0m\n' "$1"; }

if [ ! -f "$ROOT/.env.local" ]; then
  echo "Missing .env.local — run ./scripts/provision.sh first."
  exit 1
fi

cat <<'TXT'
This will:
  1. create a PRODUCTION-only Telegram session → Vercel env
  2. redeploy production so isolates pick it up
  3. create a LOCAL-only Telegram session → .env.local
  4. assert the two fingerprints differ
  5. smoke-check the MCP endpoint

You will enter the phone / login code / 2FA TWICE (once per session).
Never paste or copy a TELEGRAM_SESSION string between local and Vercel.
TXT

step "1/5  Production Telegram login (Vercel only)"
note "Telegram will send code #1 now."
npm run telegram:login:production

step "2/5  Redeploy production"
PROD_URL="$(npx --no-install vercel ls --prod 2>/dev/null | grep -oE 'https://[a-zA-Z0-9.-]+\.vercel\.app' | head -n 1 || true)"
if [ -z "$PROD_URL" ]; then
  echo "Could not find a production deployment URL."
  exit 1
fi
note "Redeploying $PROD_URL"
npx --no-install vercel redeploy "$PROD_URL" --target production

step "3/5  Local Telegram login (.env.local only)"
note "Telegram will send code #2 now — a different session from production."
npm run telegram:login:local

step "4/5  Assert session isolation"
npm run telegram:assert-session-isolation

step "5/5  Smoke-check MCP"
MCP_URL="$(sed -n 's/^MCP_RESOURCE_URL=//p' "$ROOT/.env.local" | head -n 1)"
MCP_URL="${MCP_URL:-https://gram-scope-roan.vercel.app/api/mcp}"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' "$MCP_URL" || true)"
echo "GET $MCP_URL → HTTP $CODE (expect 401 without a bearer token)"
if [ "$CODE" != "401" ]; then
  echo "Unexpected status — check the deployment before using Cursor."
  exit 1
fi

cat <<'TXT'

Done.
- Production session lives only in Vercel.
- Local session lives only in .env.local.
- Restart Cursor MCP servers if tools still look stuck, then retry a read-only tool.
TXT
