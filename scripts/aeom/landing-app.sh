#!/usr/bin/env bash
# The public landing as All Eyes On Me starts it (.aeom/config.json "start"): a production build of
# apps/dashboard against the e2e mock of Supabase and the Armada server (apps/dashboard/e2e/mock-supabase.ts),
# signed out, no account, no database. PORT picks the dashboard's port (4317 by default), so AEOM's workers
# can run side by side. The build is reused while no source of the dashboard changed since it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="$ROOT/apps/dashboard"
PORT="${PORT:-4317}"
MOCK_PORT="${AEOM_MOCK_PORT:-54399}"

# The same throwaway values as apps/dashboard/playwright.config.ts: nothing here is a secret.
export NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:$MOCK_PORT"
export NEXT_PUBLIC_SUPABASE_ANON_KEY="e2e-anon-key"
export NEXT_PUBLIC_AUTH_PROVIDERS="github,google"
export ARMADA_MCP_URL="http://127.0.0.1:$MOCK_PORT/mcp"
export ARMADA_ENCRYPTION_KEY="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
export GITHUB_APP_CLIENT_ID="Iv1.e2e" GITHUB_APP_CLIENT_SECRET="e2e-client-secret" GITHUB_APP_SLUG="armada-tvc" GITHUB_APP_ID="8675309"
export MOCK_PORT DASHBOARD_ORIGIN="http://127.0.0.1:$PORT" NEXT_TELEMETRY_DISABLED=1

cd "$APP"
if ! curl -fs "http://127.0.0.1:$MOCK_PORT/health" >/dev/null 2>&1; then
  nohup bun e2e/mock-supabase.ts >"${TMPDIR:-/tmp}/aeom-mock-$MOCK_PORT.log" 2>&1 </dev/null &
  for _ in $(seq 50); do curl -fs "http://127.0.0.1:$MOCK_PORT/health" >/dev/null 2>&1 && break; sleep 0.2; done
fi
if [ ! -f .next/BUILD_ID ] || [ -n "$(find src public next.config.* package.json -newer .next/BUILD_ID -print -quit 2>/dev/null)" ]; then
  bunx next build >&2
fi
exec bunx next start -p "$PORT" -H 127.0.0.1
