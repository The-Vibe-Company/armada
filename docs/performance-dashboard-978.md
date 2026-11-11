# Dashboard page load and bundle evidence (#978)

## Small application change

The sandbox page waited for its whole parallel sandbox/golden/member-directory
batch before starting connection/account metadata. Those secondary reads need
the authorized sandbox row, not unrelated labels or a slow member directory.
They now start as soon as that row arrives, including optional owner-only
recovery choices. All rendering still awaits the same results.

`requireViewer`, selected-organization scoping, RLS interior access, metadata-only
fallback and the owner/bindable-status recovery predicate are unchanged. No
interior-dependent request is made when the authorized row is absent. No data
cache, access widening, new query, UI control, dependency or migration.

## Repeatable controlled browser before/after

Production Next16.4.5 build, Bun1.4.2, Chromium158.0.8127.18, Ubuntu x64,
390×844 mobile viewport, cold browser contexts, two warmups + five samples.
The existing local Supabase/MCP fixture used explicit100ms read latency and300ms
member-directory latency to expose the straggler dependency. Same fixture/runtime/
network settings on both revisions; not a staging or real-iPhone measurement.

| Observed metric | Before p50/p95 ms | After p50/p95 ms |
| --- | ---: | ---: |
| Browser TTFB | 522 / 524 | 419 / 424 |
| Visible heading | 592 / 608 | 481 / 493 |
| First contentful paint | 572 / 572 | 480 / 496 |
| Loaded conversation | 947 / 959 | 844 / 861 |

Mock waterfall: first connection metadata starts405ms after the first backend
read before,205ms after. The dependency moved; no authorization check was removed.
Benefits depend on which independent read is the straggler. This does not prove
an equal gain on staging, uniform backend latencies or physical phone hardware.

The probe waits for visible content/paint/loading completion, not fixed sleeps.
It reports missing paints/conversation observations with missing sample counts,
not invented zeros. Existing permission/recovery/chat/keyboard tests:21 passed.
No wall-clock threshold was added to CI. Current mobile screenshots were inspected
against the real mock-backed production build; no visual design changed.

## Bundle measurement: no speculative rewrite

The local production manifests' reachable JS assets (sum of unique assets, gzip9):
login32,500B; sandbox list219,399B; sandbox detail241,291B. Before/after unchanged.
CSS reachable files gzip15,772B. Manifests are not a complete network waterfall:
bootstrap/prefetched resources differ. The browser separately records script
encoded/decoded bytes observed through the load event (371,078/1,210,715B here).
These are local build/network measurements, not deployed CDN transfer estimates.

The documented Next radix-ui import-optimization setting produced identical
asset bytes in an experiment. It was reverted; no experimental flag or artificial
lazy-loading/focus delay is shipped to claim a bundle improvement.

## Coordinator staging command

The API probe remains unchanged unless a dashboard origin is explicitly supplied.
After deploy, same host/network/API fixtures, the existing command can also record
browser metrics and any locally available build manifest sizes:

```sh
bun install --frozen-lockfile
(cd apps/dashboard && bunx playwright install chromium)
# Export STAGING_URL, STAGING_ORG and ARMADA_TOKEN securely as before.
# For an authenticated page, export DASHBOARD_STORAGE_STATE as a private Playwright
# staging session-state JSON filename OUTSIDE this repository; never its contents.
python3 scripts/perf/staging.py --samples 20 --golden smoke-modal \
  --dashboard-url https://YOUR-STAGING-DASHBOARD \
  --dashboard-path /sandboxes/EXISTING-OWNED-FIXTURE-UUID > /tmp/armada-dashboard-after.json
```

The UI fixture must already exist: the one disposable API/model sandbox is stopped
and deleted BEFORE the browser probe starts. Missing/expired UI state causes a
redirect/error result, not a successful authenticated-page claim. `ARMADA_TOKEN`
is API-only; it is never converted into a browser login or forwarded to the browser
helper. No live staging browser credentials were available in this coding session.

For browser-only retries (no extra model allocation), use the same helper directly:

```sh
DASHBOARD_PERF_URL=https://YOUR-STAGING-DASHBOARD \
DASHBOARD_PERF_PATH=/sandboxes/EXISTING-OWNED-FIXTURE-UUID \
DASHBOARD_PERF_SAMPLES=20 bun scripts/perf/dashboard.ts > /tmp/dashboard-only.json
```

Default path is public /login. Bundle-only inspection of a local production build:
`DASHBOARD_PERF_BUNDLE_ONLY=1 bun scripts/perf/dashboard.ts`. Build with the intended
configuration first; local manifests are not automatically the deployed artifact.
Post deployed SHA/full JSON on #978 and compare the same route/session/viewport.
API serverMs remains separate from browser navigation/paint time; no fabricated
server phase trace for a Next document is claimed.

## Local fixture / privacy

The existing e2e mock defaults to zero added delay. Only benchmark invocations set
DASHBOARD_PERF_DELAY_MS and DASHBOARD_PERF_DIRECTORY_MS; /__test/perf records bounded
fixed table names/timestamps, no headers/queries/bodies. Epoch reset excludes late
requests from earlier samples. Use the existing mock and production app, then set
DASHBOARD_PERF_MOCK=1 only for loopback fixture runs. No new deployed service.

The helper reports fixed numeric/boolean metrics and version strings only; no URL,
DOM text, cookies or response bodies. It filters supplied session state to the
chosen origin, strips driver debug/credential environment, blocks cross-origin
navigation, and saves screenshots only in explicit local-mock mode. The Python
wrapper validates the numeric protocol and suppresses helper stderr. Offline
probes confirm cleanup-before-browser, no credential forwarding, rejection of
unsafe output and known production targets before allocation. Orchestrators are
excluded from changes and selected validation.
