# V2 hygiene pass 2 — THE-2030

Audited `81ff10ef34620bb3affb29a3b16898b7c872f4d6` (2026-10-29), current main
at launch, against `docs/v2-desktop.md`, THE-1982 and Spec 8/8 (THE-2011).
This continues [pass 1](v2-hygiene-1.md), after the next ten merged tickets.
Scope: protocol, daemon (including `coordinator/`), plugin-api, bundled plugins,
app, desktop and `e2e/`. The installed `test-audit` skill replaces the ticket's
older `audit-tests-dev` name. Read-only discovery covered tests, their owners,
callers, history and CI routing in three lanes before edits.

The launch excludes in-flight THE-1996, THE-2025, THE-2028, THE-2019, THE-2013
and THE-2017. Their files were inspected on this baseline but are not changed.
Their findings below are explicit follow-up cuts for the coordinator, not claims
that their open branches have landed. No new issue was created by this worker.
No protocol source, version, recorded wire fixture or readiness line changes.

## Test audit: removed fragment

No whole test declaration or journey was removed. In
`packages/daemon/test/server.test.ts`, “credential socket writes and fake-model
use never expose the key to replies, events or logs” contained a locally defined
`model` that asserted the key/provider supplied directly by the test, returned a
literal, and was followed by a manual `store.append`. It never called a
production model or coordinator. It was introduced by `7ade337` (#336) as
credential smoke. The fake has no production callers and unlocks no production
or shared-support deletion.

Removed that eight-line fake/call/guard fragment, used its literal directly in
the existing append, and renamed the test to its actual credential socket
contract. Risk is low: the same test still verifies actual saved credentials,
write/status FIFO, zero credential events, reconnect, and absence of the key in
replies, events, console logs and SQLite files. The independent persisted
provider/key owner is `credential-keychain.test.ts`; coordinator lifecycle and
rules suites exercise real coordinator paths. This edit makes no claim of
model-provider leak coverage: that belongs to THE-2017's actual model path.
Focused proof: Node server, credential-keychain, tracker and tracker-WebSocket
suites. No replacement test or test-only production seam was added.

## Deferred test candidates and retained owners

Each candidate has a disposition rather than an implicit deletion quota.

| Candidate, history and actual failure detected | Remaining proof, safe cut, risk and follow-up |
| --- | --- |
| `app/test/anatomy.test.tsx`, “are found, with the title line and the theme”; skeleton `aeddf9c` (#327). Fixed three-file inventory fails on a behavior-preserving relocation. | Continue pass 1's row. Neighboring direct reads, imports/typecheck, build, SSR and browser anatomy already require these owners. No source/support deletion. Low risk; rerun anatomy/build. Defer to THE-2019/2025/2028, which own this file. |
| `daemon/test/plugins.test.ts`, “missing app config boots the bundled hello plugin”; `17f4e41` (#332). Detects failure of default catalog/missing-config activation through `bootDaemon`. | Same file's “armadad loads the bundled catalog before announcing server readiness” starts the actual process with missing config/default catalog and proves loaded hello status before readiness. Boot is called by server/desktop; CLI reads its status. Remove only the 18-line duplicate, no support/source deletion. Low risk; run daemon suite. Defer to THE-2019. |
| `app/src/sky/Sky.tsx`, `SkyProps.clock`/`reducedMotion`; `2411d75` (#341). Override branches have no caller supplying either prop, including tests. | Production uses browser time and system reduced-motion preference; sky tests inject `createSkyView` directly. Remove props/override branches, preserve defaults; validate sky/build suites. Defer to THE-2025. |
| `app/src/sky/view.ts`, `SkyView.flock`; #341. Only sky tests inspect its ship maps, targets, velocity and depth; production Sky uses resize/show/stop. | Animation tests protect real movement, arrival/merge and depth behavior; there is no stronger complete owner yet. Rewrite those assertions through recorded drawing geometry before removing this exposure. Do not delete whole tests. Defer to THE-2025. |
| `app/test/sky.test.ts`, legend test's no-h1 assertion; #341. Repeats the source-wide anatomy owner. | Keep canvas/accessibility legend assertions, remove only the duplicate h1 fragment. No source deletion. Low risk; sky/anatomy proof. Defer to THE-2025. |

The primary owner table from pass 1 remains in force, with these updates and
new contracts. Multiple layers remain only where they cover distinct failures.

| Contract | Retained owner / distinct risk |
| --- | --- |
| JSON/version admission, malformed IDs, ordered/project-isolated cursors, known payloads and extension-preserving folded rows | `protocol/test/protocol.test.mjs`; independent wire contract, now eight tests. |
| Durable exclusive-cursor replay and SQL append-only enforcement | `daemon/test/store.test.ts`. |
| Fleet state, inbox, queue, holds, first decisions, generation fencing and rules projection | `daemon/test/fold.test.ts`. |
| Recorded provider reads, pagination/completeness, pinned-head workflow attempts, cancellation/coalescing, incremental changes, watermark safety and append recovery | `daemon/test/github.test.ts`, `tracker.test.ts`; separate provider risks. |
| Reader wiring/credential preflight/config admission/shutdown; responsive live replay while a provider hangs | `daemon/test/readers.test.ts`, `tracker-websocket.test.ts`; actual composition, now in the normal test glob. |
| Process readiness, reconnect/session isolation, batching, malformed/version refusal, paths/origins, credential transport and recorded subscription bytes | `daemon/test/server.test.ts`; transport and process risks beyond fold/schema tests. |
| Atomic scoped keys, permissions/symlinks/XDG roots, fallback precedence, sanitized errors, native architecture and plugin secret namespace | Daemon `credential-keychain`, `keychain`, `keychain-boundary`, `credentials`, `plugin-keychain` suites. Source restrictions are independent security contracts. |
| Manifest/API/config validation before import, registry rollback/ownership/lifecycle, generated catalog discovery and readiness ordering | `daemon/test/plugins.test.ts`; discovery and activation are separate risks, except the duplicate above. |
| Pi storage replay, minted IDs and append-before-publish; crash recovery before/after tool result; prompt tool vocabulary | `daemon/test/coordinator-storage.test.ts`, `coordinator.test.ts`. Prompt inventory is a contract, not a copied implementation inventory. |
| Exclusive coordinator ownership, failed-boot release/shutdown; native tool refusals/idempotency/receipts, pinned merge/validation evidence and revisioned rules | `daemon/test/coordinator-lifecycle.test.ts`, `coordinator-tools.test.ts`. |
| Actual faux-model import never discloses unrelated TOML content | `daemon/test/coordinator-rules.test.ts`; model-boundary proof independent of file parser cases. |
| Client discovery/cursors/reconnect/backoff/refusals and credential acknowledgment | `app/test/client.test.ts`; client lifecycle independent of server/protocol. |
| Tolerant folded-state admission, reasons/steps, viewer-day timezone, count/headline/time formatting | `app/test/overview.test.ts`; UI projections. Pass 1's `sessions.test.ts` has gone; counts remain covered here/browser. |
| Fold → subscription → rendered fleet/rules, live updates, per-project scope, long-list content visibility and failure alert | `app/test/fleet.test.tsx`, `project-rules.test.tsx`; real composition/DOM performance contracts. |
| Source-wide title/fonts, theme/cn agreement and rendered shell facts/sidebar | `app/test/anatomy.test.tsx`; source-wide proof includes screens browser tests do not render. |
| Built JS budget/lazy Motion, credential DOM/storage clearing, loaded fonts/sidebar, live same-node row changes | `app/test/build.test.ts`; actual build/headless browser boundaries. |
| Sky mapping, reduced motion, settled frame cessation, launch/merge/state drawing, narrow layout, frame budget and legend | `app/test/sky.test.ts`; retain the animation contracts pending internal-state rewrite above. |
| Real child readiness/static serving, shutdown, failed startup, quit-before-ready, timeout/SIGKILL and spawn errors | `desktop/test/daemon.test.ts`. |
| Bundled Electron daemon preserves native keyring loading/credential response | `desktop/test/bundled-daemon.test.ts`; unique packaging regression from #349, beyond source-process proof. |
| Recording secret hygiene and three V1 dashboard journeys | `e2e/cache.test.ts`, `e2e/tests/dashboard.e2e.ts`; unchanged. No V2 e2e journey exists on this baseline. |

## Architecture review, continuing pass 1

| Rule and location | Disposition |
| --- | --- |
| Protocol owns known event vocabulary: `daemon/src/events.ts`, `protocol/src/fleet.ts`. | Pass 1's main duplication resolved by THE-2022 (`ce2a5a9`, #343): daemon compatibility module is type re-exports only. No duplicate known-kind inventory in plugin-api. Keep this compatibility path; it is used by adapters. |
| Protocol owns project rules: `daemon/coordinator/rules.ts`, `protocol/src/rules.ts`. | Conforms: Typebox tool schema is generated from protocol `rulesJsonSchema`, not manually copied. |
| Remaining phase/session vocabulary: `app/src/fleet/state.ts` copies Phase/session-state/flow-step enums; `daemon/src/tracker/changes.ts` has nine phase values and `tracker/linear/index.ts` seven active phases. | Follow-up under THE-2022/Spec 1: use shared protocol schemas for app subsets while preserving tolerant rows, and intentionally expose a shared phase contract for adapters (currently private). Preserve Linear's active-only subset. App state belongs to THE-1996; protocol is explicitly untouched here. These copies remain listed rather than silently claiming complete vocabulary deduplication. |
| Plugin event admission: `plugin-api/src/index.ts:34–45`, `daemon/src/boot.ts:30`. | Follow-up under Spec 8: generic envelope permits nonempty timestamps while protocol requires ISO dates; both enforce safe integer cursors through Zod .int(). Boot casts generic input to EventInput. Align the boundary while preserving unknown-kind extensibility and plugin API compatibility. Tightening acceptance is a behavior change outside this pass. |
| Variable providers behind seams: `daemon/src/server/readers.ts`, `src/forge/{github,normalize,types}.ts`, `src/tracker/linear/index.ts`. | Continue pass 1's Spec 8 extraction: server directly constructs GitHub/Linear adapters rather than consuming registry providers. Move implementations to bundled plugins with declared ctx.events/secrets. Defer concurrent composition work; no contract changes here. |
| Model identities in `protocol/src/index.ts`, `daemon/src/keychain.ts`, credential handlers and `app/src/components/CoordinatorKey.tsx`/`protocol/client.ts`. | Continue pass 1's model-plugin follow-up, owned by in-flight THE-2017. Baseline still hardcodes Anthropic/OpenAI. |
| One durable fleet/coordinator log: `daemon/coordinator/storage.ts`, `native.ts`, `src/store.ts`. | Conforms: armada.pi checkpoints, tool receipts and armada.tools rules use EventStore. Inherited MemoryStorage is a replay projection, not a second authoritative store. |
| Configuration lives in app: `daemon/src/plugins/config.ts`, `status.ts`. | Conforms to Spec 8: config.json owns switches/settings; its .plugins.json is derived last-boot status. Routing/policy comes from folded coordinator checkpoints. No config layering introduced. |
| Reader composition included in normal checks. | Pass 1's deviation resolved: `tracker-websocket.test.ts` matches daemon's normal test glob and no longer accepts the cross-checkout override. Remove obsolete Knip integration entry. |

Other boundaries conform on this baseline: SPA production imports protocol only;
dev/test daemon imports stay outside its bundle. Electron owns window/process
lifecycle, fleet folding is pure and storage uses node:sqlite. V2 has no V1
runtime imports, Effect, subscription OAuth, hosted fleet state, relay or sync.
Copied pure dashboard math is allowed by the brief; no dashboard module is imported.

## Terminal and machine differences

No baseline V2 test branches on isTTY, requires `/dev/tty`, or wraps workers with
the `script` utility. Daemon subprocess fixtures use explicit pipes/ignored
stdin; browser tests are headless. Searches for HTML script tags are not a
terminal dependency.

THE-2013's conformance fixtures are absent from this baseline and remain out of
scope. Read-only inspection of open PR #344 at
`592b31f1c7bd7aaf91bd863f044f3b41e7209e21` found its original BSD `script`
wrapper already replaced by piped spawn in
`packages/cli/test/fixtures/plugin-test/positive/index.mjs`. Its new headless
regression installs a fake `script` that fails with tcgetattr/ioctl; runtime
worker fixture uses readline. This is an inspected in-flight fix, not a merged
baseline verification. Recheck its actual head when it lands.

Platform differences retained deliberately:

- `credential-keychain.test.ts` skips the system-storage/XDG subprocess case
  off Linux. Actual macOS keychain access is not proved on Linux.
- Desktop bundled-daemon test needs Electron, Linux shared libraries and the
  real native keyring binding. Its preload loads the real host binding before
  stubbing the OS read and simulating darwin; it proves packaging, not macOS
  acceptance. Native window/Cmd+Q checks still need a Mac.
- Daemon/desktop tests need modern Node with node:sqlite and POSIX signals.
  App browser tests need pinned Chromium and runtime libraries. Sky's mean
  frame budget varies with machine load; it does not use a terminal or sleep.
- Unrecorded e2e agent steps need model credentials (replay-only can skip them);
  this is a credential distinction rather than a terminal distinction.

## Dead code and repeatable scan

```sh
bunx knip@6.43.0 --config knip.v2.json
```

Extended `project` coverage to daemon `coordinator/**/*.ts`, plugin-api sources
and `packages/plugins/*` (hello is the only merged provider). Package exports
are intentional entry points. Future provider packages match the workspace glob;
THE-2013 fixtures/tests will need explicit entries when they land. Removed the
obsolete integration glob and artificial tracker barrel entry: the real server
now imports the barrel. No blanket export/type suppression added.

Removed only unused internal exports, preserving their implementation:

- `sessionStep` and `sessionReason` exports from `app/src/fleet/overview.ts`;
  only `fleetItems` calls them. Introduced by #335.
- `buttonVariants` export from `app/src/components/ui/button.tsx`; only Button
  uses it. Remove pass 1's associated Knip exception. Introduced by #327.
- Tracker barrel's unused LinearFetch, LinearOptions, PollClock, PollOptions
  and PollStatus re-exports (`daemon/src/tracker/index.ts`, #331).
  Keep original option/status contracts where used and LinearFetch at the
  real test/provider owner. PollClock itself becomes private in `poll.ts`.
  These modules are not package export entry points.

No whole production file or dependency was proven removable. Package exports
from protocol/plugin-api/daemon remain public contracts. Scope exceptions:

| Exception | Concrete disposition |
| --- | --- |
| `app/src/protocol/client.ts` types | Existing ProjectLog exception; local signature type, deferred to THE-1996/2017's concurrent client work. |
| `app/src/components/fleet/FleetList.tsx` exports | TONE and StepBar are local-only on baseline; THE-2028 owns rows. Two finding names, one path-scoped exception; remove/re-audit once that branch lands. |
| `app/src/fleet/state.ts` types | Phase, FoldedPullRequest, FoldedInboxItem, FoldedQueueEntry and FoldedValidation exports unused; THE-1996 owns file. Defer together with schema duplication above. |
| Root types for picomatch/proper-lockfile; V1 workspaces/CI discovery | Same scope exceptions as pass 1: V1 dependencies are not removable from a V2 scan. Root TS plugin is disabled to avoid loading V1 dashboard config; V2 TS sources remain analyzed. Bun auto-discovery stays disabled in favor of explicit V2 test entries. |

With these documented concurrent-path dispositions, the pinned command exits
zero: no unused files, exports, types, dependencies or unresolved imports. This
is not a claim that exceptions are dead-code-free; each is a named follow-up.

## Verification

Bun 1.4.4, Node 24.22.1. Verification results and exact PR head/CI evidence are
recorded in the pull request and ignored
`plans/ship-pr-dev/runs/20261029-221339-armada/` artifacts. The initial verify
attempt stopped at formatting of the edited Knip config; the config was formatted
before functional validation. No baseline failing test was removed.
