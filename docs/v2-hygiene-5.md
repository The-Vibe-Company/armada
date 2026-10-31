# V2 hygiene pass 5 — THE-2101

Read-only discovery audited merged main `eccba85a3a9a95b474652b102c018b2fc3ad2819`
(2026-10-31), after the thirteen ticket merges since [pass 4](v2-hygiene-4.md),
against THE-1982 and [the V2 brief](v2-desktop.md). Separate app-test and
architecture lanes preceded the cuts; the worker also audited child processes,
keychain isolation, caller/history evidence and the pinned Knip graph.
The installed `test-audit` authoring gate applies throughout.

Scope is V2: protocol, plugin-api, daemon, bundled plugins, app and desktop.
THE-2075, THE-2079, THE-2093–2099, THE-2086 and THE-2081 are excluded from
behavior edits. Findings describe this merged baseline, not their branches.
No protocol source, recorded wire fixture, version or readiness bytes change.
Coordinator approval limits daemon test edits to `ARMADA_KEYCHAIN=file` beside
each temporary `XDG_CONFIG_HOME`; all other assertions and lifecycle code stay.

## Test audit: cuts and surviving proof

Each row records the actual failure detected, history, callers, change,
surviving owner, risk and focused validation. No baseline failure is removed.
No new test or test-only production seam is introduced.

| Candidate, history and actual failure detected | Change, remaining owner, risk and focused proof |
| --- | --- |
| `app/test/room-header.test.tsx`, “a pill per state that holds an agent, in the states' order, on its state's dot”; #380 (`76f0464`). One regex pins a particular span and Tailwind utility serialization, so a behavior-preserving class refactor fails it. Production `Room` and the panel browser fixture render the same `Header`. | Remove only that regex and its explanatory comment. `room-panel.test.tsx`, “below 900 px the panel is a sheet…” builds the production stylesheet and requires the words' computed position to be `absolute` and the button's accessible name to remain `1 blocked`. State/count/color/order, stale-read and toggle proof stays. No support/source deletion. Low risk; `bun test packages/app/test/room-header.test.tsx packages/app/test/room-panel.test.tsx`. |
| Real-main children in `daemon/test/reader-boot.test.ts` (five boot modes; #378), `plugins.test.ts`, “armadad loads the bundled catalog before announcing server readiness” (#382), and `account.test.ts`, “daemon startup serves local clients while its saved account API is unavailable” (#374). Temporary XDG paths alone do not select file storage on macOS. #390 (`5acb30f`) fixed this for other launches but omitted these three environments. | Add only `ARMADA_KEYCHAIN: "file"` beside the temporary XDG path in each child environment. Preserve Node selection, offline preloads, every assertion and finite 8/10-second lifecycle deadline. Surviving owners are these same real-entry readiness, account-outage and credential-redaction cases, plus `credential-keychain.test.ts`'s gateway/file permission and root-selection cases. Test-only environment changes, no production deletion. Low risk; Node owner suites and their Bun-hosted discovery. |
| `desktop/test/bundled-daemon.test.ts`, “Electron's bundled daemon starts a configured coordinator and reads credentials through native keyring”. Its explicit preload stubs the native read and selects Darwin. An inherited `ARMADA_KEYCHAIN=file` could silently bypass that native adapter and fail its storage assertion. | Explicitly clear the inherited override in this child's environment. Retain the real packaged Electron/native-binding boundary, bounded build hook and behavior deadline, offline preload and `os-keychain` assertion. Do not apply file storage to this intentional fake-native contract. Low risk; bundled-daemon owner, including a parent environment set to file storage. |

The daemon children already use shared `nodeExecutable`: `process.execPath`
under Node; a bounded real-Node resolver under Bun. Keep that distinction:
offline `--import` preloads must not silently run under Bun. The stale-socket
child is a plain Node socket, and the coordinator restart child injects its
model rather than booting the real keychain owner. Source desktop children
already set file storage. The direct Linux root-selection subprocess also
sets it. `macKeychain()`'s lock-only test acquires filesystem locks without
reading an OS credential; its fake gateway tests remain independent contracts.

## Retained owners and false positives

| Contract | Retained owner / distinct risk |
| --- | --- |
| Dotted tool names in declarations, normalized transcripts, tool calls/results and reversed replies | `daemon/test/models-registry.test.ts` and coordinator integration proof. Wire spellings here are a provider compatibility boundary, not cosmetic string coupling. THE-2097 owns registry changes. |
| Shared web sign-in, denial/expiration, cancellation, logout issuer and API-key precedence, project secrets, offline fallback, commit/shutdown race and secret absence | `daemon/test/account.test.ts`; each setup creates its own machine directory and random credentials. Socket broadcasting and store absence are distinct transport/persistence risks. Keep explicit positive prerequisites. |
| Folder inspection, atomic registry persistence/rollback, duplicate roots, live add/remove and history | `daemon/test/projects.test.ts`; inspection, storage and composed runtime/transport failures are distinct. THE-2081/2093 owners remain untouched. |
| Gateway namespace, permissions, symlink refusal and OS-adapter boundary | `credential-keychain.test.ts`, `plugin-keychain.test.ts`, `keychain-boundary.test.ts`; the static boundary guard independently enforces an architecture/security contract. |
| Settings defaults/schema, legacy daemon, refused plugin, stale reply and restart reconciliation | Settings browser and pure suites; only demonstrated navigation/markup duplication is deferred, not all SSR checks. THE-2075 excludes edits. |
| Panel storage bounds, modifier keys, route/focus ownership, unknown agents, live release and responsive sheet | `room-panel.test.tsx`, `room-agent-lane.test.tsx` and route/session owners. The cheap rule cases protect edges absent from the browser scenarios. |
| App mark and PNG/ICNS format | `desktop/test/icon.test.ts`; independent generated-asset/platform contract, not a duplicate component test. |
| Source daemon readiness, reaping, restart, occupied port, startup failure/deadline and quit | `desktop/test/daemon.test.ts`; separate platform/lifecycle failures with fresh fixtures and finite deadlines. Its timeout/escalation case intentionally exercises real production timers. |
| Packaged native binding and coordinator boot | `desktop/test/bundled-daemon.test.ts`; distinct from source execution and deliberately fake-native, never a read of the owner's credentials. |

The room panel/lane browser suites build/start in bounded 60-second setup
hooks, tear down in 10 seconds and open fresh browser contexts per scenario.
Account reloads a fresh fixture page; Coordinator opens fresh contexts. Keep
these setup budgets separate from behavior deadlines. Room browser polling
uses a bounded monotonic deadline; no unbounded sleep was added. Real daemon
process tests are lifecycle tests with their own deadlines and cleanup, not
browser/database setup accidentally charged to an interaction timeout.

## Architecture review

| Rule and location | Disposition |
| --- | --- |
| One alias owner, `daemon/src/models/registry.ts`: `wireContext`, `harnessNames`, `safeStream` | Conforming. Both stream wrappers map outgoing contexts and reverse returned names through the same owner. Keep explicit normalized-transcript regressions. No speculative extraction or excluded registry edit. |
| One credential store and sign-in flow, `daemon/src/server/account.ts` and core's account entrypoint | Conforming. The actual daemon owner is `server/account.ts`, not a second `account/` tree. It uses core's machine paths/read/update, credential resolution and device approval flow. Stored-session lifecycle intentionally differs from CLI environment API-key precedence. No second credentials-file parser. |
| One room routing/lookup owner | `lib/route.ts` owns panel/lane address rules; both `AgentLane` and full `Session` use `session/view.ts`'s `findSession` and shared StateCard/Facts/Steps/Reports. The full-page route remains live through App and the lane's link. |
| One Settings layout | Sections share `settings/Layout.tsx`. Keep behavior; private export candidates and stale app README descriptions await THE-2075. |
| Compact and detail fleet reads | `coordinator/read.ts` owns `fleetStatus`, `ticketRead` and `fleetHistory`; native dispatch supplies envelopes. Its bounded compact `line()` is local. Detail data/history have different contracts, no second formatter was found. |
| Retired UI and compatibility paths | No `screens/Plugins.tsx`, old Agent screen or single-line composer remains. Current Header is the compact header. `pluginModels` remains live through `server/models.ts` for custom plugin selections; do not delete compatibility code because pi is now the default catalog. |
| Local authority and plugin boundaries | App production uses protocol/local UI; shell owns native facilities; daemon/store owns durable state. No V1 hosted store, new sign-in path or protocol contract enters the cleanup. `docs/runbook.md` remains the live V1 runbook. |

## Dead code and repeatable scan

```sh
bunx knip@6.43.0 --config knip.v2.json
```

Install the frozen workspace dependencies before scanning; otherwise Vite
configuration imports cannot resolve. The baseline completed scan reports two
unused files, two dev dependencies, ten value exports and two type exports.

| Candidate, history and callers | Cut and surviving owner |
| --- | --- |
| `app/src/room/follow.ts`, `AT_END_PX`; #375 (`ed86473`). Only this module's transition uses it; no test imports it. Pass 4 deferred it while scrolling was in flight. | Make local. `follow.test.ts`, “free scrolling re-arms at the end, or within 40 px once it left that band”, and `thread-scroll.test.tsx` retain rules/browser proof. Low risk; focused follow/scroll suites. |
| `app/src/room/unread.ts`, `PillLabel`; same history. Only this module's StatusPill/PILLS uses the type. | Make local. `sidebar.test.tsx`, “the pill says a waiting question first, then a running turn, then a failed one; nothing when idle”, and browser watermark/pill cases retain proof. No emitted behavior changes; low risk; sidebar suite. |
| `account-settings-page.tsx` / `coordinator-settings-page.tsx`; live string entrypoints passed to `Bun.build` by their browser tests | Register the two files in Knip; retain them. No dead fixture deletion or blanket ignore. |
| Runtime-plugin tests absent from Knip's project graph | Register Claude, Codex, OpenCode and Conductor `test/**/*.test.ts` entrypoints and test TypeScript projects, matching the existing reader/node entries. Conductor's `HostedReader` is production-instantiated and directly tested; its tests use core's account helpers. Retain those owners. |

Remaining findings are recorded rather than suppressed: Settings
`SETTINGS_SECTIONS`, `SettingsNav`, `SettingsGroup`, `NEEDS_ARMADA`;
registry `wireToolName`; chat `cutOutput`, `refused`, `chatOf`; GitHub's
`GithubFetch` type reexport. They belong to the excluded/current owner review
in THE-2083. Public protocol and plugin API exports stay contracts regardless
of repository consumers. V1 workspace exclusions and root type dependencies
keep the earlier ledgers' explicit scope dispositions.

The completed post-cut scan has zero unused files, eight value exports, one
type export and one dev dependency. Conductor's `@armada/protocol` dev
dependency remains reported after registering its tests; it has no direct
source/test import on this baseline. Dependency and lockfile changes remain
outside this batch and its runtime package is excluded by THE-2093; THE-2103
owns reassessing the merged result. This is a recorded finding, not a clean
scan claim.

The daemon README now distinguishes pi's catalog/keychain sign-in from the
still-live custom model plugin compatibility path; it drops the obsolete
claim that all model choice happens through the old key form and restart.
Selection-precedence changes remain THE-2097's work.

## Flakiness and follow-ups

The coordinator's raw local merge logs are unavailable in this checkout;
this pass does not claim to have audited every local verify this week.
#390's commit records the concrete macOS failure: the real-main stale-socket
test waited for a Keychain prompt and timed out at ten seconds. The three
remaining unguarded real-main child environments have the same storage risk;
this batch completes the explicit file override, not a longer timeout.
Linux checks cannot prove macOS prompt behavior.

THE-2087's dashboard cli-api root-verify failure is V1 and note-only here.
Retain loaded-machine startup risks as evidence-qualified follow-ups; no
failing test is renamed a flake or removed without a reproduced root cause.
Keep the packaged build in its bounded setup hook and all independent
readiness/restart deadlines. No shared earlier-case state was demonstrated
in the audited new app/daemon fixtures.

| Follow-up / parent | Work deliberately deferred |
| --- | --- |
| [THE-2102](https://linear.app/thevibecompany/issue/THE-2102) / Spec 10, THE-2067 | After THE-2075, reassess Settings markup duplication and Account's `noToken` helper: it rejects literal `armada_` although its fake supplies no secret. The daemon's generated-secret protocol/log/store assertions are the security owner. Update app README's old Coordinator/Providers descriptions against merged behavior. |
| [THE-2083](https://linear.app/thevibecompany/issue/THE-2083) / Spec 10, THE-2067 | Existing private-export cleanup, refreshed with NEEDS_ARMADA/wireToolName and current live pluginModels/HostedReader evidence. Reassess excluded owners after they land. |
| [THE-2082](https://linear.app/thevibecompany/issue/THE-2082) / Spec 9, THE-2048 | Existing room geometry/color/hit-area and hero-fixture follow-up; this pass removes only one assertion already duplicated by actual production-CSS proof. |
| [THE-2103](https://linear.app/thevibecompany/issue/THE-2103) / Spec 8, THE-2011 | After THE-2093, reassess the Conductor protocol dev dependency with its tests in the scan graph. Keep core's live account helpers and the runtime's owner tests. |

## Verification and limits

Baseline `bun run verify` passed before cuts: 2,423 Bun tests, 14 protocol
tests, plugin conformance, 247 daemon/plugin Node tests and 12 desktop tests.
Focused post-cut proof passed: 27 app cases, 33 Node daemon/keychain cases,
28 Bun-hosted process cases and eight desktop cases with a file-only parent.
The latter explicitly proves that the packaged fixture still uses its native
adapter while ordinary source children select private file storage.

Final verification counts, integrated-main SHA, production versus test/support
LOC, independent review coverage and latest-head CI are recorded with the PR
and ignored `plans/ship-pr-dev/runs/20261031-081116-armada/` artifacts.
Browser checks use pinned Chromium and synthetic offline fixtures. Source
Node and packaged Electron are separate proof; neither proves a macOS window
or live Keychain dialog. No visible product change or new owner visual
validation is claimed.
