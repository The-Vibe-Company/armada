# Fixture dashboard navigation

This local browser benchmark is not unit CI or deployed-provider evidence. It
resets the fixture, signs in as Alice, and exercises the real destination links.
Five measured transitions follow one warmup per path. Each sample starts with a
fresh source document (empty router cache); visible sidebar prefetch is included.
It reports click-to-destination-heading wall time and first destination loading
indicator/heading DOM mutation separately. Neither is proof of hydration completion.
Request records expose browser RSC prefetch/action traffic, not server-to-server
API calls or SQL. No launch or mutation server action is needed to navigate.

Use a **production build**: Next disables automatic prefetch in development.
In a fresh shell at the repository root, with ports 3100/54399 free:

```sh
export NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54399
export NEXT_PUBLIC_SUPABASE_ANON_KEY=e2e-anon-key
export NEXT_PUBLIC_AUTH_PROVIDERS=""
export ARMADA_MCP_URL=http://127.0.0.1:54399/mcp
export ARMADA_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
export ARMADA_DATABASE_URL="" STATS_TOKEN=""
export GITHUB_APP_CLIENT_ID=Iv1.e2e GITHUB_APP_CLIENT_SECRET=e2e-client-secret
export GITHUB_APP_SLUG=armada-tvc GITHUB_APP_ID=8675309
export MOCK_PORT=54399 DASHBOARD_ORIGIN=http://127.0.0.1:3100
(cd apps/dashboard && bun run build)
(cd apps/dashboard && bun e2e/mock-supabase.ts)
```

Leave the mock running. In another shell with the same environment:

```sh
cd apps/dashboard
NODE_OPTIONS=--require=./e2e/github-fetch.cjs bun --bun next start -p 3100 -H 0.0.0.0
```

From the repository root, run:

```sh
node scripts/perf/dashboard-navigation.mjs
# Or pass the executable path of an existing compatible Chromium installation.
```

Use the same browser, machine, fixture, and method at both revisions. Rebuild
and restart Next between revisions. Do not point this at staging or production:
the script intentionally resets fixture state. Stop both servers afterwards.

## Blocking work inventory

- Shared shell: verified viewer claims, selected organization and memberships.
  Viewer/client/membership reads already use request-scoped React cache; no
  cross-user cache should replace those checks.
- Sandboxes: metadata inventory, then costs and host names; directory, provider
  setup and Docker-host discovery run concurrently. Existing Suspense supplies
  loading feedback. No server action is required.
- Detail: selected-org sandbox, then provider-specific account choices, account
  metadata, golden label and connection reads. The directory overlaps the
  authorized sandbox read and its dependent reads rather than gating them. Chat events load
  separately after mounting. Interior authorization must not be bypassed.
- Snapshots: active goldens and history, setup followed by capabilities, plus
  launch/account/connection/template/vault data. These are concurrent except
  real dependencies. Active and historical queries must remain separate unless
  pagination completeness is guaranteed: a capped history cannot replace the
  active-only query.

The sidebar's forced full prefetch renders all visible dynamic destinations,
including unrelated expensive setup pages. Measure on-demand navigation separately
from already-prefetched/back navigation before accepting a policy change.


## Server-read waterfall experiment

To observe backend fetches, use **Node** to start the same production build.
Bun's Next launcher did not apply this preload during measurement, so those
runs were discarded. In the app directory with the fixture environment above:

```sh
NODE_OPTIONS="--require=./e2e/github-fetch.cjs --require=../../scripts/perf/dashboard-fetch.cjs" \
  node node_modules/next/dist/bin/next start -p 3100 -H 0.0.0.0
```

The server prints local fixture fetch start/end time and duration, path only.
No headers, request/response bodies or query strings are logged.

For a controlled scheduling experiment, set DASHBOARD_PERF_DELAY_MS=80 on
that server command. This adds the same 80 ms to the org-member directory
and sandbox-connection reads on the loopback fixture service only. Run the
unchanged browser benchmark at both revisions with that same delay. With no
variable set the preload only traces. The delay is bounded to 0–1000 ms.

This demonstrates overlap when both independent reads have latency, **not**
real provider/database performance or a production speedup. Build each
revision first; stop/restart Next between builds; keep the same Node version,
browser and fixture. Keep browser metrics and server traces together so the
timing result can be reconciled with dependency ordering.
