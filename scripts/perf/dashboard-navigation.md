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
- Detail: selected-org sandbox and directory, then provider-specific account
  choices, account metadata, golden label and connection reads. Chat events load
  separately after mounting. Interior authorization must not be bypassed.
- Snapshots: active goldens and history, setup followed by capabilities, plus
  launch/account/connection/template/vault data. These are concurrent except
  real dependencies. Active and historical queries must remain separate unless
  pagination completeness is guaranteed: a capped history cannot replace the
  active-only query.

The sidebar's forced full prefetch renders all visible dynamic destinations,
including unrelated expensive setup pages. Measure on-demand navigation separately
from already-prefetched/back navigation before accepting a policy change.
