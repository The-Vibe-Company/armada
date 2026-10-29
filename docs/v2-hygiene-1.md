# V2 hygiene pass 1 — THE-2021

Audited `7ade337670845ee4c980d28fc901f59909046b05` (2026-10-29), the ten-ticket
baseline named by THE-2021, against `docs/v2-desktop.md`, THE-1982 and Spec 8/8
(THE-2011). Scope: protocol, daemon, app, desktop and `e2e/`. The concurrent
THE-1991, THE-1993, THE-2012 and THE-2020 branches are excluded. Discovery used
the installed `test-audit` skill; the older `audit-tests-dev` name in the ticket
is not installed. This is a conservative first pass, not a deletion quota.

## Tests removed and remaining owners

No complete test declaration or journey was removed. One obsolete assertion
fragment was removed from `packages/daemon/test/keychain.test.ts`, inside
“owner keychain wins; absent/locked entries fall back to gh without leaking
source errors”: the simulated `security find-generic-password` invocation and
its exact argument/call inventory (12 lines).

The old GitHub adapter introduced it in `754d8ac` (#330). `7ade337` (#336)
replaced production macOS access with native `@napi-rs/keyring`, but kept a
command-backed macOS branch solely to preserve that assertion. No production
caller supplies `GithubTokenOptions.platform` or calls `macKeychain` with
arguments. The same retained test already exercises priority through the real
`Keychain` gateway with `FakeKeychain`, then checks missing/locked fallback to
`gh auth token`, sanitization and cancellation. This unlocks deletion of the
platform option, conditional backend construction and the macOS adapter's
command/signal injection. The actual `gh` adapter injection remains.

Risk is limited to an unused internal injection path; default platform behavior,
wire messages, readiness output and credential priority are unchanged. The
native macOS binding cannot be exercised on this Linux runner; its architecture
boundary test remains. Focused proof is the Node keychain, credential-keychain,
keychain-boundary, credentials and GitHub suites (12 tests).

Each row below names the primary test owner for its contract. Similar scenarios
in other rows remain only for the distinct storage, transport, client or browser
risk named there. All in-scope suites were read, including their production
owners, callers, history and CI entry points.

| Contract | Retained owner |
| --- | --- |
| Wire JSON round trips; older/newer-major admission; additive minor compatibility; malformed correlation IDs; ordered/project-isolated safe cursors | `packages/protocol/test/protocol.test.mjs` (five tests, one per contract group) |
| Durable exclusive-cursor replay and project filtering; SQLite rejects UPDATE/DELETE/REPLACE | `packages/daemon/test/store.test.ts` (two tests) |
| Pure session state/steps; project-isolated inbox; FIFO queue; independent holds; first validation decision; generation-fenced replay; tracker sessions; delayed previously unseen old claims | `packages/daemon/test/fold.test.ts` (eight tests) |
| Recorded GitHub reads, changed-only persistence and restart; pagination failure; bounded/coalesced reads; pinned-head/workflow attempts; polling/redaction; interrupted append recovery | `packages/daemon/test/github.test.ts` (six tests) |
| Recorded/incremental Linear changes; edited questions/answers; nested pagination/ancestry; watermark preservation; redaction; abort-ignoring gate; full-read removal/local generation | `packages/daemon/test/tracker.test.ts` (seven tests) |
| Credential handler failures are sanitized; malformed secret requests refused | `packages/daemon/test/credentials.test.ts` |
| Atomic coordinator credentials and account scope; Linux file permissions/symlink refusal; real system-storage/XDG subprocess regression | `packages/daemon/test/credential-keychain.test.ts` (three tests) |
| GitHub owner keychain priority, gh fallback, sanitized errors and abort | `packages/daemon/test/keychain.test.ts` (retained test described above) |
| Providers cannot bypass credential gateway/native adapter | `packages/daemon/test/keychain-boundary.test.ts` (independent architecture/security contract from THE-1995) |
| Real process readiness/shutdown; live commits; restart replay/future cursors; session isolation; malformed/version refusal; static paths/origins; serialized secret-free credential transport | `packages/daemon/test/server.test.ts` (seven tests; read-only overlap) |
| Actual WebSocket replay/live delivery stays responsive while Linear fetch hangs | `packages/daemon/test/tracker-websocket.integration.ts` (one opt-in test) |
| Project discovery/subscription; per-project cursor deduplication; reconnect/backoff; each major refusal direction; server refusal; unreadable frames; regressing cursors; bad addresses; stop; one-shot credential acknowledgement; remote write refusal | `packages/app/test/client.test.ts` (12 tests, distinct client lifecycle risks) |
| Only open, well-formed sessions count | `packages/app/test/sessions.test.ts` |
| Source-wide title/font rule; Tailwind/cn theme agreement; rendered facts/title/sidebar anatomy | `packages/app/test/anatomy.test.tsx` (retained, app read-only) |
| Built first-load budget/lazy animation split; credential form clearing/reload; browser sidebar/live updates/loaded fonts | `packages/app/test/build.test.ts` (three tests) |
| Real daemon child readiness/static serving/stop; failed startup cleanup; quit-before-ready; timeout/SIGKILL; spawn-error settlement | `packages/desktop/test/daemon.test.ts` (five tests) |
| Recording credential hygiene | `e2e/cache.test.ts` |
| Anonymous landing/access gate; actual sign-in/overview; persisted approval/next item | `e2e/tests/dashboard.e2e.ts` (three unchanged V1 dashboard journeys; there is no V2 e2e journey yet) |

Retained false positives: schema round trips enforce a public wire contract;
source keychain restrictions enforce a security boundary; font/title greps cover
modules not rendered by today's screen; the theme inventory prevents utility
merging drift; storage replay and socket replay protect different failure modes.

Deferred test candidate under THE-1991: `anatomy.test.tsx`, “are found, with the
title line and the theme” (three fixed filenames). Added by skeleton `aeddf9c`
(#327), it detects a source relocation rather than behavior. The production
build, direct theme/title reads and browser anatomy test already fail if these
owners disappear. No production/support deletion is unlocked. Keep this PR
clear of `packages/app`; the next owner can remove it after rerunning that suite.
The SSR anatomy test also checks the daemon address in the facts line, so it is
not a proven duplicate of the browser test and remains.

## Architecture review

| Rule and location | Disposition |
| --- | --- |
| Pure rules with injected adapters; native macOS secrets never passed via subprocess arguments. `daemon/src/keychain.ts`, `daemon/src/secrets/macos.ts` retained a test-only subprocess route. | Fixed here: remove the obsolete injection branch alongside its stale assertion. Production already used native access. |
| Spec 8: variable providers register through versioned seams and consume only declared context. `daemon/src/forge/{github,normalize,types}.ts` use daemon event types/keychain; `daemon/src/tracker/linear/index.ts` uses the host keychain/local tracker contracts. | Deferred to provider extraction under THE-2011, after THE-2012's plugin API. Move implementations to bundled plugins and use `ctx.events`/declared `ctx.secrets`; no contract rewrite during this audit. |
| Shared event vocabulary belongs to the protocol. `daemon/src/events.ts` duplicates protocol vocabulary; `fold.ts` uses local types, `server/index.ts` serializes folded tables as JSON. The daemon README still calls protocol work future THE-1985. | Follow-up under Spec 1 (THE-1983), coordinated with Spec 8/THE-1991 and THE-1993. Align event ownership and stale documentation without changing wire behavior. Protocol and concurrent server files untouched here. |
| Spec 8: model variants come from plugins. `protocol/src/index.ts`, `app/src/protocol/client.ts`, `app/src/components/CoordinatorKey.tsx` hardcode Anthropic/OpenAI identities. | Follow-up under THE-2011 after THE-2012 model seam work. Requires protocol/UI decisions; forbidden in this no-behavior-change pass. |
| Composition proof must run in the normal check. `daemon/test/tracker-websocket.integration.ts` is still opt-in and retains `ARMADA_TEST_DAEMON_ROOT` for a once-parallel server; daemon's `test/*.test.ts` script skips it. | Follow-up with THE-2020 under Spec 1 after reader wiring lands: promote the existing test and retire the cross-branch override. Run it explicitly here; do not delete its unique proof. |

These are the complete deviations found in this baseline, not claims that future
build steps are already implemented. Per launch instruction, overlapping changes
are listed for the coordinator to cut after the in-flight work merges. No new
tracker tickets were created by this worker.

Boundaries that conform: shipped SPA imports only the protocol, Electron owns
window/child lifecycle rather than fleet rules, fold/rules are pure, SQLite uses
`node:sqlite`, there are no V1 runtime imports, subscription OAuth, Effect,
relay/sync or hosted state in the V2 production graph. The app's fake daemon
imports host credentials only in development/test tooling, outside the SPA build.

## Dead code and repeatable scan

Run from the repository root:

```sh
bunx knip@6.43.0 --config knip.v2.json
```

The version is pinned in the command and schema. No dependency or lockfile change
is needed. The config includes tests, dev tooling, the Electron/daemon entry
points, protocol package exports and the existing journeys. Protocol and daemon
package entry exports remain intentional APIs, not dead merely because no local
consumer imports every member. Root project files cover e2e; V1 workspaces and GitHub workflow discovery are
excluded from findings. Bun test auto-discovery is disabled in favor of explicit
V2 test entries. Root dependency findings are interpreted only for this scope
(root scripts can still reference shared tooling). Root TypeScript plugin
discovery is disabled because the root typecheck script also loads V1 dashboard
configuration; source TypeScript is still analyzed.

Removed:

- `GithubForge` export in `daemon/src/forge/github.ts`; the class has only its
  local `GithubReader` constructor as a caller. The class and behavior remain.
- Unused `TokenCommand` type re-export from `daemon/src/forge/keychain.ts`.
  The type at its real owner, `daemon/src/keychain.ts`, remains available.
- The test-only platform option and macOS command branch described above.

No whole production file or dependency was proven safe to remove. Important scan
dispositions:

| Candidate / scanner exception | Reason |
| --- | --- |
| `daemon/src/tracker/index.ts` reported unused on baseline | Keep as an explicit entry: incoming THE-2020 PR #337 already imports `linearTracker`/`TrackerPoller` through it. Its `PollClock` re-export remains part of that seam. |
| `app/src/components/ui/button.tsx` unused `buttonVariants` export; `app/src/protocol/client.ts` unused `ProjectLog` export | Two path-scoped export/type exceptions, deferred to THE-1991. Re-audit and remove exceptions after it lands. |
| App `SAMPLE_EVENTS` and desktop `DaemonAddress` exports | Source inspection suggests local-only use, but scan does not independently flag them in the chosen entry graph; retain when in doubt. |
| Root `@types/picomatch`, `@types/proper-lockfile` | Used by excluded V1 CLI/core, not removable based on a V2-only scan; root dependency exceptions. |
| `tailwindcss` | Used by CSS `@import`; include CSS in the app project so Knip resolves it. |

The command reports no dead files, exports, types, unused/unlisted dependencies
or unresolved imports after these documented dispositions. No blanket export or
type suppression is used. In-flight plugin/coordinator packages must be added to
a later pass's scope rather than silently absorbed into this baseline.

## Verification

Baseline: Bun 1.4.4, Node 24.22.1; protocol 5/5, daemon 36/36, desktop 5/5,
app plus recording hygiene 22/22 passed. The explicit tracker/WebSocket
composition test also passed. No baseline failure was deleted.

Final proof and PR/CI evidence are recorded in the pull request and the ignored
`plans/ship-pr-dev/runs/20261029-191920-armada/` artifacts. No protocol or readiness
line bytes, app files, daemon server tests, or journey definitions were changed.
