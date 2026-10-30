# V2 hygiene pass 4 — THE-2077

Discovery audited merged main `dad87188688f6292adaf59beeffb141ae0431839` (2026-10-30), after the fifteen ticket
merges since [pass 3](v2-hygiene-3.md), against THE-1982,
[the brief](v2-desktop.md), Spec 9 (THE-2048) and Spec 10 (THE-2067).
The release commit and night-run documentation are not additional product
slices. Separate app-test and architecture discovery lanes were read-only;
the cross-cutting process/flake review and caller searches preceded these cuts.
The installed `test-audit` authoring gate applies throughout.

Scope is V2: protocol, plugin-api, daemon, bundled plugins, app and desktop.
No protocol source, recorded wire fixture, version or readiness bytes change.
THE-2054 (thread scrolling), THE-2068 (account), THE-2073 (pi models), THE-2074
(provider status) and THE-2070/2071/2075 (Settings sections) are excluded from
production edits. THE-2079's wake-up contracts are also untouched. These notes
refer to the merged discovery baseline, not unmerged implementations. Approval
explicitly excludes `plugins/github/src/inspect.ts`; test-runner edits may
overlap the daemon suites, and main must be rebased before hand-back.

## Test audit: cuts and surviving proof

Each row records history, actual failure detected, callers, the cut and its
remaining owner. No failing baseline test is removed to make verification pass.
No new test or test-only production seam is introduced.

| Candidate, history and actual failure detected | Change, remaining owner, risk and focused proof |
| --- | --- |
| `app/test/notify.test.tsx`, “a toast in the live region, held while hovered, gone on its own after its time; Open the room opens it”; #373 (`dad8718`). Its `daemon.pending` waits observe an injected fake timer, rather than the platform timeout. `notify-page.tsx` alone supplies `Schedule`; production `App` mounts `<Notifications/>` with defaults. | Remove `Schedule`, `windowSchedule` and the three levels of scheduler props; the toast effect owns `window.setTimeout/clearTimeout` directly. Remove the fixture's due-map clock, `pending` and `elapse`, and its two internal timer-count waits. The same browser test uses Playwright's clock for the real timer, retaining the hover hold, deadline boundary, removal, Open and current-room suppression. Neighboring Dismiss/route-change and saved-switch cases remain. All test bodies and observable assertions remain. Low risk; `bun test packages/app/test/notify.test.tsx`. |
| `app/test/work-rows.test.tsx`, “a finished turn folds into Worked for 2m 03s above its answer…”; #370 (`6fa1f4a`). A regex pins the exact button/span/SVG nesting; another assertion repeats that the closed fold has no calls. | Remove those two assertions. The same file's browser owner starts with a fresh context, finds the named fold, clicks it and requires `aria-expanded=true` and the group before opening calls; a fold initially open fails that interaction. `view.test.ts` independently owns grouping, duration, line termination and stable keys. Keep the SSR row/line-state and unique timestamp proof. No support/production deletion; low risk; work-rows and view suites. |
| `app/test/work-rows.test.tsx`, “a single call is its own row…”; #370. The `data-tool` check also pins `div` and `min-w-0`; another regex pins Lucide's generated class and exact stroke width. | Keep `data-tool` without the element/class coupling; remove the Lucide serialization assertion. `view.test.ts`, “a tool call's sentence comes from its name and input” owns tool-to-icon selection, including `merge.check`; the remaining row SSR owns its accessible label and raw-name tooltip. No public byte contract requires Lucide's generated class/stroke markup. Geometry/color assertions without stronger proof are retained for THE-2082. No support/production deletion; low risk; work-rows and view suites. |
| `daemon/test/reader-boot.test.ts`, five “daemon reader boot” modes; #363 (`471f45c`). Top-level `execFileSync("node", ["-p", "process.execPath"])` performs another unbounded PATH lookup before test deadlines. Other Node-run suites launch the PATH's `node` directly. | Replace the unconditional resolver with shared test support: Node-run suites use `process.execPath`; when root Bun discovers these suites, a single bounded lookup selects the real Node executable. Reader-boot, server, plugins, coordinator, credential-keychain and desktop source-process tests retain the original Node boundary. Keep every readiness, durable restart, private-storage and credential-redaction assertion, including the Node preload that keeps real boot offline. The catalog generator still accepts either host runtime. Low risk; Node owner suites and full verify. |
| `daemon/test/server.test.ts`, “armadad starts beside a crashed socket…” (#329, later #363), and `plugins.test.ts`, “armadad loads the bundled catalog before announcing server readiness” (#332). Both real-process cases lacked a test deadline. | Add finite 10-second behavior deadlines; retain process-exit cleanup and every assertion. They cover process readiness, crashed-socket preservation, reader shutdown and plugin activation order; none is a duplicate render smoke. No new test or source seam; Node server/plugins suites. |

Retain the notification question-toast SSR: browser proof exercises answered
toasts, so the question's presentation is a distinct branch. Keep the pure
notification state-machine cases (first-read suppression, deduplication,
permissions, missing storage, focus and badges) and the browser lifecycle proof.

## Retained owners and false positives

| Contract | Retained owner / distinct risk |
| --- | --- |
| Public minor-4-to-7 chat envelopes, version admission and recorded wire bytes | `protocol/test/protocol.test.mjs`; public exports are contracts even without repository consumers. |
| Durable owner chat, safe failures, project isolation and restart | `daemon/test/chat-server.test.ts`; transport and persistence beyond app rendering. |
| Pi committed/partial mapping, 80ms coalescing, tool identity/failure, Stop, shared views, legacy clients and attachment/disposal races | `daemon/test/chat-live.test.ts`; injected clock, ordered socket barriers and bounded cases. Fake conversations expose pi's public view API rather than implementing the wire mapping asserted. No duplicate mapper or test removal warranted. |
| Partial/read reconciliation, joining mid-turn, stable keys, queued/withdrawn messages and old-daemon fallback | `app/test/room-live.test.tsx`; pure reducer cases cover edge states absent from its long browser scenario. |
| Work labels, icons, ranked summaries, interrupted/aborted turns, stable fold keys and duration boundaries | `app/test/view.test.ts`; browser work-row tests separately own disclosures, refusal details and sessionStorage reload. |
| Markdown safety, project-scoped links, images, code/table clipboard, footnotes and owner-message folding | `app/test/thread.test.tsx`; sanitizer/security cases and browser interactions are independent. Concurrent THE-2054 paths remain unchanged. |
| Composer keyboard/IME behavior, draft/history persistence and actual submission | `app/test/composer.test.tsx`; pure storage rules and browser input each have distinct risks. No obsolete single-line implementation remains. |
| Starter-ask eligibility and hero/dock transitions, including reduced motion | `app/test/hero.test.tsx`; eligibility negatives construct their own folds. Its hand-written CSS fixture is a follow-up, not a production-stylesheet claim. |
| Notification suppression/delivery and browser toast lifecycle | `app/test/notify.test.tsx`; the browser now exercises native timer wiring. `desktop/test/bridge.test.ts` separately owns shell reveal/badge/origin validation. |
| Settings routing, schema forms, refused providers, saving/restart and stale replies | `app/test/settings.test.tsx`; `build.test.ts` independently owns production navigation, keyboard focus and compact layout. |
| Reader first-success health, credential precedence and safe boot failure | `daemon/test/reader-boot.test.ts`, `readers.test.ts`, `plugin-keychain.test.ts`; preserve all synthetic offline modes. |
| Known runtime launch failure, generation/provenance scope, refusal/retry and durable worker cleanup | `daemon/test/workers.test.ts` and Codex/OpenCode process owners; do not remove retry prerequisites as redundant. |
| Safe test merge, forge head pinning, holds and confirmed-merge recovery | `daemon/test/merge.test.ts` and `plugins/github/test/merge.test.ts`; host policy and provider transport are different boundaries. |
| Actual local process-group races and reaping | `plugins/node-local/test/local-node.test.ts`; THE-2057's deterministic signal errors and close prerequisite remain. |
| Source process readiness/restart/quit and packaged Electron/native binding | `desktop/test/daemon.test.ts` and `bundled-daemon.test.ts`; source and packaged runtime are distinct platform risks. |

All listed new browser suites already launch in bounded `beforeAll` hooks
(30 seconds) and close in bounded `afterAll` hooks (10 seconds). No sleep or
`waitForTimeout` was found. Notification, hero, live-room and Settings cases
create fresh fixture worlds/contexts; work rows has one browser lifecycle case.
Thread's shared-page cases restore disclosures and use separate controls; no
borrowed earlier-case state was demonstrated. Keep these as retained findings,
not speculative flake fixes.

## Architecture review

| Rule and location | Disposition |
| --- | --- |
| One turn/fold owner: `app/src/room/view.ts`, `chat.ts`, `Thread.tsx`, `Live.tsx`. | Conforming. `chat.ts` reconciles live identities with durable readings; `workRows` alone groups/folds tools; Thread renders that result. Live elapsed time and completed duration deliberately have different rounding/padding contracts, each with a retained owner. No speculative merger. |
| One pi-view-to-wire mapper: `daemon/src/server/chat.ts`, `chat-live.ts`. | Conforming. Live imports `viewChat`, `textOf` and `reasoningOf`; committed tools and live tool frames share the same mapping. The fake-view transport suite catches safe error text, truncation and sticky failed tools. Excluded model/wake-up owners remain untouched. |
| Production owns toast timers: `app/src/notify/Notifications.tsx`. | Fixed. The scheduling override had no non-test caller. Remove it and the custom page clock; retain cancellation on hover/focus/unmount through the component's effect and browser-time control outside production. |
| Settings uses the shared v7 page anatomy. | Conforming on this baseline: shared `Page`, `PageHeader` and `DaemonProblem`, facts/title/quiet text before `SettingsFrame`, shared fonts/tokens and grouped rows. No competing page title. Ongoing section behavior belongs to Spec 10. |
| Retired UI/tool paths. | Already resolved: #372 (`d1a52af`) moved `screens/Plugins.tsx` to `settings/Providers.tsx` and `CoordinatorKey.tsx` to `settings/Coordinator.tsx`; #370 replaced `toolLine`; #365 replaced the single-line composer. Current daemon/desktop README navigation now says Settings > Providers. Historical reports keep their historical names. |
| Plugin/host boundaries and local authority. | No new violation found in the reviewed paths: app production imports protocol/local UI, Electron owns window/process/notification facilities, and daemon plugins use context/registry. SQLite's append-only log remains authoritative; pi memory and the room are projections. No V1 runtime, hosted store, relay or sync is introduced. |

## Dead code and repeatable scan

```sh
bunx knip@6.43.0 --config knip.v2.json
```

Register the actual `Bun.build` entrypoints `test/notify-page.tsx`,
`room-live-page.tsx` and `thread-page.tsx` explicitly in Knip. They were reported
as unused files because their callers use entrypoint strings; all remain live.
No new blanket suppression or dependency/lockfile change is needed.

| Private candidate and history | Cut and surviving owner |
| --- | --- |
| `HERO_HEADLINE` (#373); only used inside Hero | Make local; hero rendering/chip-send owners unchanged. |
| `ALERTS`, `FOLD_CHARS`, `FOLD_LINES` (#366); only used inside markdown-rules | Make local; retain markdown alert/security and folding-boundary proof in thread tests. |
| `ArmadaShell` (#373); only used by its module's `Window` augmentation | Make local; keep the augmentation and notification/desktop-bridge owners. |
| `LiveEntry` (#371); only used in the same module's live state | Make local; live reducer/browser owners remain. |
| `DraftKeeper` (#365); no caller | Delete unused type alias; live `draftKeeper` and composer storage/input owners remain. |

The remaining scan findings belong to excluded owners: `SETTINGS_SECTIONS`,
`SettingsNav`, `SettingsGroup`, daemon `cutOutput`, `refused`, `chatOf` and
GitHub's `GithubFetch` reexport. Record them; do not suppress them to claim a
zero scan. `ChatResult`, `ChatSent`, `OwnerAnswered` and `ChatStopped` are public
protocol exports: absence of an in-repository consumer is not dead-code proof.
`pluginModels` is still used on this baseline; reassess after THE-2073 rather
than declaring its unmerged replacement delivered. V1 workspace exclusions,
root type dependencies and test/entry scope retain the previous ledgers'
explicit dispositions.

## Flakiness and follow-ups

The coordinator's raw local merge logs are not present in this worker checkout.
Tracker hand-back/merge-refusal comments supply the following evidence; this
is not a claim to have audited every local merge run:

- THE-2016's 2026-10-30 merge refusal records node-local's bounded-tick
  `eventually` failure on main and three unresolved-launch-intent failures.
  Its later hand-back records corrected refusal prerequisites and green
  verification; #359 made process polling use a bounded monotonic deadline.
  Keep those positive prerequisites; do not classify all retry failures flaky.
- THE-2057/#369 repaired the dead process-group EPERM race with deterministic
  owner cases and actual-close proof. That repair is retained unchanged.
- THE-2068's account subprocess/version issue is excluded. Other Node-run child
  tests now use their runner's `process.execPath`; Bun-hosted discovery resolves
  the actual Node executable through bounded shared test support. The first
  post-cut full verify caught four failures when a direct `process.execPath`
  launched Bun and skipped the Node `--import` offline preload; focused Node
  runs alone did not catch that host mismatch. Preserve both host checks. No
  version-specific experimental child flags were found in those suites. The packaged Electron
  smoke deliberately uses Electron, and Bun-to-Node conformance deliberately
  selects Node. These boundaries must not silently turn into Bun children.
- Baseline full verification passed; no additional failure is labelled a flake
  without evidence and a root-cause ticket.

| Follow-up / parent | Work deliberately deferred |
| --- | --- |
| [THE-2082](https://linear.app/thevibecompany/issue/THE-2082) / Spec 9, THE-2048 | After thread scrolling lands, replace class/serialization assertions only with demonstrated production-stylesheet geometry, color and hit-area owners; assess the hero's hand-written CSS fixture. Preserve motion, keyboard, safety, clipboard, scrolling and disclosure proof. |
| [THE-2083](https://linear.app/thevibecompany/issue/THE-2083) / Spec 10, THE-2067 | Reassess the excluded Settings/chat/GitHub private exports after their owners land, including the explicitly excluded `inspect.ts` reexport and `pluginModels` after THE-2073. Keep public protocol exports. Findings describe merged discovery source, not those unmerged branches. |

Pass 3's retired reader-loop and host credential/model-preset notes remain
historical follow-up context; this pass does not claim they were repaired.

## Verification and platform limits

Before cuts: the focused 19 app and 18 Node process cases passed; full
`bun run verify` passed with 2,271 Bun tests, 10 protocol tests, plugin
conformance, 176 daemon/plugin Node tests and 10 desktop tests. No failure was
removed. Toolchain: Bun 1.4.4, Node 24.22.1; CI also runs Node 22.

Final focused/full verification, the exact pinned scan findings, rebase base,
production versus test/support LOC, independent review and latest-head CI
are recorded in the PR and ignored
`plans/ship-pr-dev/runs/20261030-the-2077/` artifacts. Browser checks use pinned
Chromium, synthetic data and offline routes. The Electron smoke exercises the
packaged native binding; it does not prove macOS windows, Keychain or real OS
notifications, which still require a Mac. No visible behavior changes or new
owner visual validation are claimed.
