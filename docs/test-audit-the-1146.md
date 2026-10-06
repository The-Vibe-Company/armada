# THE-1146 test cutover

This applies THE-1145’s owner-lane ledger, not a new wholesale deletion audit. The authorized plan covers 31 repairs, 23 conditional consolidations and one deletion. No entire test file is removed. Independent public-helper, package, architecture, storage, security and transport contracts remain.

## Refreshed baseline

Pinned main: `9cd474b0443cc75ef77f1acc7d414f28176e0435`. Compared with the original ledger pin `4fb197721bc05993e07acd935c9697b40741daf4`, 44 test/support paths changed. Current discovery records 1,349 TypeScript declarations in 141 files; all later regressions in those files remain outside the 55 authorized dispositions unless their assertion is explicitly carried here. The CLI launch/relaunch and merge-queue suites are preserved.

Bun 1.4.2, Node 24.14.1, TypeScript 5.9.3, Linux x86_64 cloud sandbox. The CI package gate uses Node 22. Baseline lint/typecheck/Bun succeeded: 1,585 cases, zero failures, two snapshots, 12,974 assertions. Bun time 373.54 s; complete verify sequence 432.51 s. This is the `bun run verify` script’s exact lint → typecheck → Bun sequence, with JUnit reporter flags added to record every file. The original audit’s timing on another checkout/host is not a speed comparison.

Fourteen Python skill/tooling cases also pass; these are outside Bun/CI discovery and are retained. No baseline full-suite product failure was present. Isolated workers quota failed due to another case’s ABC-12 log; isolated secrecy passed without performing any secret operation. Both defects are repaired at their existing owner. Their isolated candidates now pass: worker quota 1 pass / 11 filtered / 36 assertions; secrecy 1 pass / 5 filtered / 19 assertions.

## Lane cutovers

| Lane | Retired layer | Keepers / remaining proof |
| --- | --- | --- |
| Core | Parser invocations in feature suites; duplicate scalar/lifecycle invocations | config, fleet-api, inbox, requests, plans, routing, catchup and merge owner suites; seven repaired owner assertions |
| CLI | Duplicate missing-key and doctor-notice invocations; expected-helper and substring-only errors | CLI configuration-error keeper, minimum/daily release keepers, real worker release suppression, native runtime argv, full sanitized errors |
| Dashboard storage/API | Order-dependent negatives, unobserved persistence/refresh and SQL adjacency | PGlite API/store tests with own operations, whole-read generations, seven-day rows and precise notice lifecycle |
| Dashboard UI/artifacts | Core reexport proofs; landing keyboard duplicate | core owner-items, shared keyboard, rendered header/font registration, actual responsive geometry/raster pixels, public help and complete ranking |
| Skills/tooling | Mock-publication callback in doctor; no independent Python/tooling layer is retired | Existing server cli-version publication owner plus core npm transport; all 14 Python cases retained |

The only unlocked production simplification is removal of `MethodSteps.stepForKey`: the real caller now uses the existing shared `tabStep`, after its vertical keys and wrapping move into that owner’s keeper. Public helper exports and the launch binding seam have real consumers or independent safety proof and remain.

## Every authorized disposition

Names and original lines below refer to THE-1145’s pinned ledger. Current keeper details describe this cutover; original evidence/history remains in [the audit](test-audit-the-1145.md).

| Original declaration | Mark | Keeper / carried proof |
| --- | --- | --- |
| `packages/core/test/attachments.test.ts` — L21 — all four supported image types are recognized from bytes, never filenames | C | Image magic rows join byte-sniffing admission; quotas move to config defaults/overrides. |
| `packages/core/test/attachments.test.ts` — L28 — attachment quotas and retention are configurable positive integers | C | Image magic rows join byte-sniffing admission; quotas move to config defaults/overrides. |
| `packages/core/test/catchup.test.ts` — L52 — has no summary on the first visit | C | First-visit null seen/since/backAt rows join dismissal lifecycle. |
| `packages/core/test/ci.test.ts` — L336 — known failure config rejects invalid registry entry | C | Known-failure regex/ticket/unknown-key table moves to config. |
| `packages/core/test/config.test.ts` — L83 — the parked label is configurable | C | Custom parked label joins defaults/overrides; config receives the other parser tables. |
| `packages/core/test/deploy.test.ts` — L73 — failed descendants fail immediately; unrelated failures keep waiting; leases can be pending | F | Immediate descendant failures remain; unrelated failures followed by target success exercise ancestry. Parser table moves to config. |
| `packages/core/test/deploy.test.ts` — L119 — deploy targets validate live source, unique names, range and unknown keys | C | Immediate descendant failures remain; unrelated failures followed by target success exercise ancestry. Parser table moves to config. |
| `packages/core/test/fleet-api.test.ts` — L139 — a worker session claims, reports, asks, validates and releases its own ticket, and nothing else | F | Own report/validation and foreign denials join worker scope. Server time joins claim/report lifecycle. |
| `packages/core/test/fleet-api.test.ts` — L249 — times are the server's, whatever the terminal's clock says | C | Own report/validation and foreign denials join worker scope. Server time joins claim/report lifecycle. |
| `packages/core/test/heartbeat.test.ts` — L88 — stops on session end or auth refusal; transient failure retries without losing the pinned claim | F | Capture retry inputs and assert the original claimedAt; use one inactive-session outcome. |
| `packages/core/test/inbox.test.ts` — L297 — releasing a ticket resolves its open questions | C | Default single read and question/plan wake join polling; question-only release moves to requests. |
| `packages/core/test/inbox.test.ts` — L762 — without --wait the inbox is read once | C | Default single read and question/plan wake join polling; question-only release moves to requests. |
| `packages/core/test/jobs.test.ts` — L30 — validates configured commands and positive job thresholds | C | Defaults and invalid job commands/thresholds move to config. |
| `packages/core/test/linear.test.ts` — L171 — a request with no answer before the timeout fails naming Linear | C | Root timeout joins named later-page transport propagation. |
| `packages/core/test/merge.test.ts` — L579 — two coordinators merging at once merge one after the other | F | CLEAN/HAS_HOOKS join admission; overlong lease goes to fleet API validation; serialization yields via microtasks. |
| `packages/core/test/merge.test.ts` — L1102 — GitHub's HAS_HOOKS (mergeable, with pre-receive hooks) merges like CLEAN | C | CLEAN/HAS_HOOKS join admission; overlong lease goes to fleet API validation; serialization yields via microtasks. |
| `packages/core/test/merge.test.ts` — L1124 — Armada refuses a lease longer than an hour | C | CLEAN/HAS_HOOKS join admission; overlong lease goes to fleet API validation; serialization yields via microtasks. |
| `packages/core/test/plans.test.ts` — L68 — inbox --wait wakes when a worker posts a plan | C | Plan-kind wake moves to inbox; pre-approved label joins implementing plan keeper. |
| `packages/core/test/plans.test.ts` — L140 — pre-approved plans enter implementing without an approval inbox item | C | Plan-kind wake moves to inbox; pre-approved label joins implementing plan keeper. |
| `packages/core/test/redact.test.ts` — L32 — built-in patterns mask complete key formats and private blocks | F | Supported complete token literals are individually absent, alongside PEM/long-token checks. |
| `packages/core/test/routing.test.ts` — L63 — a ticket no rule matches gets default_profile | C | Default-profile/why row joins Unicode first-match matrix. |
| `packages/core/test/setup.test.ts` — L115 — Armada pointers retain discovery metadata, migrate old files and ignore instruction-only releases | F | Installed pointer frontmatter, discovery text, read command and version paths use independent literals; instruction-only compatibility remains. |
| `packages/core/test/validations.test.ts` — L186 — closes a design ticket once the owner approved it: the design on the ticket, Done, the session ended | F | Create an active design claim, approve and close; assert generation release and attachment URL. |
| `packages/cli/test/auth.test.ts` — L194 — with no key anywhere, the error names the variable and the login command | C | Missing-key recovery moves to CLI config-error keeper. |
| `packages/cli/test/cli.test.ts` — L382 — LINEAR_API_KEY is required | C | CLI config-error keeper exercises no-env and isolated empty-home cases, exit 2 and complete key/login recovery. |
| `packages/cli/test/herdr.test.ts` — L240 — failures never echo a prompt or arbitrary herdr diagnostics | F | Capture each complete native failure once; require refusal and exclude all prompt/provider/pane canaries. |
| `packages/cli/test/herdr.test.ts` — L509 — pane and metadata failures are sanitized, even when pane cleanup also fails | F | Capture each complete native failure once; require refusal and exclude all prompt/provider/pane canaries. |
| `packages/cli/test/local-setup.test.ts` — L217 — JSON and noninteractive setup never ask, save permissions, or start sessions | F | JSON and plain noninteractive rows observe no prompts, writes or native calls. |
| `packages/cli/test/login.test.ts` — L142 — ARMADA_API_KEY in the environment signs in with nothing stored, and wins over a stored session | F | Narrow the name to the actual env-key flow; core credentials retains env/stored precedence. |
| `packages/cli/test/opencode-model.test.ts` — L86 — unavailable provider catalog fails closed without surfacing metadata | F | Require catalog refusal and absence of the complete metadata canary. |
| `packages/cli/test/runtime.test.ts` — L231 — phase self-reporting uses Armada source, maps every phase, and is nonfatal | F | Literal phase/state rows at native argv replace expected values from the owner mapper. |
| `packages/dashboard/test/coordinators.test.ts` — L173 — first claim reads the pending handover owner after acquiring the project lock | F | Keep lock-before-owner/write and post-handover owner, without incidental statement adjacency. |
| `packages/dashboard/test/dashboard-facts.test.ts` — L17 — coordinator activity and inbox reads have separate clocks, reset after silence and retain seven days | F | Write at the seven-day boundary and observe persisted deleted/retained inbox rows. |
| `packages/dashboard/test/deploy-store.test.ts` — L49 — pause false still notifies, and healthy clears only an explicitly covered failure | F | Observe the exact non-pausing failure notice before healthy/no-coverage, then resolution after explicit coverage. |
| `packages/dashboard/test/owner-push.test.ts` — L497 — webhooks refuse private addresses, local hosts, userinfo, redirects and HTTP | F | Execute production safeWebhookFetch with isolated DNS/HTTPS substitutes returning 302/private Location; send the owner test through it, requiring one attempt, redirect refusal and failed delivery receipt. |
| `packages/dashboard/test/secrets.test.ts` — L279 — no value is ever logged or recorded in the audit list | F | Set, release and refuse within this case; assert populated own audit/log proof before excluding full values. |
| `packages/dashboard/test/webhooks.test.ts` — L157 — a label renamed asks every project for a whole read on its next view, without reading now | F | Two projects defer refresh, then each performs a whole read and advances its persisted snapshot generation. |
| `packages/dashboard/test/workers.test.ts` — L477 — exchanges are limited per address, and no token is ever logged or stored | F | Own successful exchange/log plus simultaneous second-address exchange; own token absence and same-address reset are self-contained. |
| `packages/dashboard/test/fleet-view.test.ts` — L69 — a project keeps its color whatever other projects exist | C | Unknown-slug literal color fixture joins demo-world; keep public projectColor. |
| `packages/dashboard/test/keyboard.test.ts` — L17 — never reach the page behind an open dialog (⌘K, a screenshot) | F | Real Chrome DOM distinguishes closed/open/ARIA dialogs and editable/outside targets; shared tab keeper absorbs vertical keys/wrapping. |
| `packages/dashboard/test/landing.test.ts` — L23 — lists every command of armada --help, in its order | F | Read public --help; keyboard rows move to shared tab owner and MethodSteps calls it; delete duplicate stepForKey. |
| `packages/dashboard/test/landing.test.ts` — L112 — moves between its steps with the arrow keys, Home and End, wrapping at both ends | C | Read public --help; keyboard rows move to shared tab owner and MethodSteps calls it; delete duplicate stepForKey. |
| `packages/dashboard/test/overview-view.test.ts` — L158 — holds only what the owner validates; the workers' questions, plans and hand-backs stay with the coordinator | C | Carry absent/decided/non-owner validations and multi-project oldest/count alerts to core owner-items. |
| `packages/dashboard/test/overview-view.test.ts` — L239 — is one card per project whose coordinator is not active while items wait for it | C | Carry absent/decided/non-owner validations and multi-project oldest/count alerts to core owner-items. |
| `packages/dashboard/test/page-anatomy.test.ts` — L74 — have one h1, the header bar's, that the shell names | F | Render real shell/PageHeader for one named heading; actual phone CSS heights stay reserved before/after content arrives. |
| `packages/dashboard/test/page-anatomy.test.ts` — L176 — gives the phone's bars a height of their own | F | Render real shell/PageHeader for one named heading; actual phone CSS heights stay reserved before/after content arrives. |
| `packages/dashboard/test/search.test.ts` — L276 — an id or name starting with the query beats a word, a word beats a substring, a substring beats letters in order | F | Require both results before ordering; all four match classes have equal-kind members. Warm each benchmark query and retain 50 ms median budget with result assertions. |
| `packages/dashboard/test/search.test.ts` — L360 — a query over 5 000 items answers well under 50 ms | F | Require both results before ordering; all four match classes have equal-kind members. Warm each benchmark query and retain 50 ms median budget with result assertions. |
| `packages/cli/test/doctor.test.ts` — L219 — older than Armada expects, it is an error whose fix installs the latest; the sign-in is not checked twice | F | Observe the server-advertised published latest release directly; retain independent cli-version/core npm publication gates. |
| `packages/cli/test/doctor.test.ts` — L245 — only inbox/status carry the daily notice; doctor stays quiet | F | A separate status terminal observes network reads and the daily notice, with independent machine state. |
| `packages/cli/test/doctor.test.ts` — L258 — a listed release stays quiet until the server verifies its tarball | F | Observe the server-advertised published latest release directly; retain independent cli-version/core npm publication gates. |
| `packages/cli/test/doctor.test.ts` — L292 — a worker is never told: it installs the version its brief names | D | Delete the fake worker credential-mode replay. The real worker-session release.test.ts keeper still observes quiet notice stderr and scope. |
| `packages/cli/test/doctor.test.ts` — L300 — a CLI older than the server's minimum gets the upgrade line only | C | Minimum-version doctor keeper asserts only the required upgrade line, quiet stderr and no extra release read. |
| `packages/dashboard/test/fonts.test.ts` — L85 — every page lists each full font before its Latin cut | F | Render root-layout font classes with isolated boundary substitutes; retain fallback order, binary freshness and actual glyph coverage. |
| `packages/dashboard/test/icons.test.ts` — L9 — are the ones \`bun run icons\` builds from the shell's mark today | F | Decode committed raster pixels and compare to today’s mark raster, retaining dimensions, mark hash and SVG freshness. |

## Preservation and mutation proof

Ten supplemental source mutations were caught, each by one filtered keeper (zero passing cases, one intended assertion failure), then restored byte for byte with matching SHA-256:

| Owner mutation | Keeper |
| --- | --- |
| Closed dialogs claim page keys | keyboard: open-dialog DOM |
| Remove ArrowDown handling | keyboard: shared tab wrapping |
| Drop full Geist registration | fonts: rendered root classes |
| Phone brand height becomes auto | page-anatomy: effective reserved geometry |
| Name prefix ranks below a word | search: prefix/word ranking |
| Remove GitHub personal-token prefix mask | redact: complete literal absence |
| Ignore failed SHA ancestry | deploy: unrelated failure then target success |
| Append a secret value to set log | secrets: self-contained set/release/refusal |
| Trim inbox history at six days | dashboard-facts: persisted seven-day boundary |
| Allow redirect following at post boundary | owner-push: production transport / failed 302 receipt |

These are supplemental proof, not a claim that every retained R contract was mutation-tested. The independent review covered all 47 initial files and all 55 ledger entries and found three gaps. Each was restored:

| Restored contract | Keeper repair | Deliberate production mutation |
| --- | --- | --- |
| A plan alone wakes inbox wait | Separate question/plan rows share the full polling fixture | Ignore new plan items in the wake predicate |
| Supported Slack app-token format is masked | Correct supported input plus complete original literal absence | Remove the app-token variant from both prefix patterns |
| Every project’s whole read keeps its own identity | Assert persisted config slug/root/repository and source root/issue/repository | Pass the widgets root to the other project’s source read |

For each, the mutant passed the pre-restoration filtered keeper (1 pass), then failed its restored keeper at the intended assertion (0 pass, 1 fail). Each production source returned byte for byte with the same SHA-256. This is the required step 6 mutation evidence, separate from the ten supplemental mutations. The same reviewer refreshed all 48 files, carried 43 unchanged entries by matching hashes, inspected all 45 OCR default exclusions directly, and reported no remaining findings. This initial cutover refresh includes the repaired tests, evidence and the added fixture correction below; a subsequent main-integration finding is recorded separately below. All original R declarations remain; no broad deletion-count target overrides their contracts.

## Product control

The repaired public-help keeper exposed a product defect: the hold help lacked a final newline, so the following inbox usage was concatenated to its prose. The source repair is committed separately from the audit cutover (`ce817ec`). Main #258 later independently includes the same newline, so the final CLI production file matches main; the control remains valid historical evidence. The same public-help/landing keeper fails on the original owner and passes with the newline. This is one real user-flow proof; no duplicate source-grep regression is added.

The first full candidate run encountered the existing CLI API suite’s combined database/auth setup exceeding Bun’s default five-second hook budget. The same standalone owner suite failed before any case ran (7.39 s control). Database bootstrap now has its own ten-second hook, matching workers/secrets, while auth retains its normal budget. All 13 unchanged API cases then pass. This test-fixture correction is a separate commit; no auth/product contract or global timeout changes. The failed candidate run (1,550 pass, one failed hook, 401.53 s Bun / 489.53 s complete sequence) is retained as diagnostic evidence, not the successful after timing.

## Pre-main cutover size and timing

Cutover counts against the refreshed baseline; TypeScript declarations 1,349 → 1,329 (−20). Twenty-four standalone declarations retire; three parser matrices and one merge admission declaration move to their owner, yielding the net reduction. The two F title corrections and polling keeper rename preserve their declarations.

| Package | Tests before → after | Support before → after | Production TS before → after |
| --- | --- | --- | --- |
| Core | 15,411 → 15,523 | 3,454 → 3,454 | 21,631 → 21,631 |
| CLI | 15,799 → 15,809 | 118 → 118 | 13,540 → 13,541 |
| Dashboard | 11,634 → 11,889 | 46 → 77 | 31,594 → 31,577 |
| Total | 42,844 → 43,221 (+377) | 3,618 → 3,649 (+31) | 66,765 → 66,749 (−16) |

Thirty-one weak assertions require stronger fixtures, so test LOC grows while duplicate declarations retire. The 31-line support module compiles real TS/TSX with per-module boundary substitutes; it avoids global mocks and adds no production hook. All 141 test files remain. Python: three files, 14 cases, 211 lines, unchanged.

Counts use tracked physical text lines (plus the intended new support file), tests separately from other files under each package’s test directory, and production TypeScript separately. The stable reviewed candidate passes lint/typecheck and 1,563 Bun cases in 141 files, zero failures, two snapshots and 13,102 assertions: 22 fewer runtime cases. Bun took 382.93 s and the equivalent full verify sequence took 443.69 s, versus 373.54 s / 432.51 s before. These single observations show no measured speedup (complete sequence +2.6%); stronger fixtures add assertions and the database/browser runs vary. Production shrinks by 16 lines. Node 22 packed-install smoke, dashboard production build and all 14 Python cases also pass.

## Main reconciliation

Main `ac7b4fb4370fdfbbbe506c06185266f065f540e6` (#256) was merged after the reviewed cutover, preserving the new merge queue parser, selected CI/local retest policy and FIFO recovery matrix. The incoming CLI queue and dashboard store regressions are unchanged. No launch/relaunch or queue regression was cut. The automatic merges in AGENTS, CLI help, config tests and merge tests retain both changes. Integration review found one additional missing proof: the new drain matrix covered default CI but did not prove configured local retesting reached the drain. A `local-retest` row now asserts both local test merges against successive fresh base tips, no branch updates and FIFO completion. No production queue behavior changes.

| Package | Current main tests → final | Support → final | Production TS → final |
| --- | --- | --- | --- |
| Core | 15,755 → 15,892 | 3,487 → 3,487 | 22,087 → 22,087 |
| CLI | 16,776 → 16,786 | 118 → 118 | 14,384 → 14,384 |
| Dashboard | 11,764 → 12,025 | 46 → 77 | 31,658 → 31,641 |
| Total | 44,295 → 44,703 (+408) | 3,651 → 3,682 (+31) | 68,129 → 68,112 (−17) |

The original refreshed baseline and equivalent before/after observations above stay pinned. Against that original pin, complete final counts are tests 42,844 → 44,703 (+1,859), support 3,618 → 3,682 (+64) and production 66,765 → 68,112 (+1,347). Incoming main contributes +1,451 test / +33 support / +1,364 production lines; the table below isolates this campaign’s +408 / +31 / −17. Latest main adds 20 declarations relative to the refreshed baseline; final discovery is 1,349 declarations in 142 files, versus main’s 1,369. All 141 baseline files remain; the extra file is main’s relaunch suite. These totals separate incoming-main growth from this campaign’s final +408 test / +31 support / −17 production lines. The additional keeper row adds 25 lines and one runtime case without another declaration. Its hardcoded-CI source mutant passes all 25 prior drain rows, then fails the repaired row (25 pass / 1 fail). The source SHA-256 is restored byte for byte. This is the fourth preservation repair and mutation, beyond the original 55 dispositions.

The first PR CI test check failed at the new phone-geometry keeper’s default five-second deadline while launching, using and closing Chrome. Its original height assertions remain; cold browser/page setup and browser cleanup now have isolated ten-second hooks, while the geometry case retains the normal five-second deadline. Both browser owner suites pass locally. This fixture correction adds six test lines, no support or production lines, and does not change a product performance budget. Final checks run again before hand-back.

Merged main before that row passes 1,599 cases in 141 files, zero failures, two snapshots and 13,480 assertions (402.15 s Bun / 465.66 s verify). Dashboard build and Node 22 packed-install smoke pass again. The first-main keeper before the browser fixture correction passes lint/typecheck and all 1,600 Bun cases across 141 files, zero failures, two snapshots and 13,490 assertions (395.65 s Bun / 455.75 s verify). At that first-main reconciliation, runtime cases are 1,621 → 1,600 (−21); the extra restored row accounts for the difference from the initial −22 cutover. The pinned comparison above remains the equivalent cutover before incoming-main growth. That first-main run is +5.4% versus the refreshed baseline, which also contains 36 fewer incoming-main cases; no speedup is claimed. The browser-fixture candidate subsequently passes the two owner suites and full 1,600-case verification (212.45 s Bun / 237.14 s verify). The previous full run was 455.75 s; this large variation means a single run cannot establish savings attributable to this campaign. All four preservation findings remain repaired and mutation-proven with byte-restored source.

Main then advanced to `3af06ad5df43b72526690ffe1b2676a4bfcd7cc2`: #227 relaunch and #259 shared-screen helper cleanup. Both were merged normally. Their relaunch/local-launch/runtime-adapter and CLI fleet regressions remain unchanged; the existing worker ownership keeper retains both named and explicit-null launch ownership alongside this campaign’s independent quota fixture. Current-main counts in the table include both incoming PRs. That second merged-head lint/typecheck and all 1,615 Bun cases pass across 142 files, zero failures, two snapshots and 13,755 assertions: 182.82 s Bun / 206.94 s complete verify sequence. Reconciled current main has 1,636 runtime cases versus the final 1,615 (−21); current main’s 1,367 declarations become 1,347 (−20). Dashboard build and packed Node 22 install smoke pass again on these production bytes.

The requested complete before/after verify observations are 432.51 s at the refreshed baseline and 206.94 s at the final merged head. The equivalent pre-main pair was 432.51 → 443.69 s; other successful candidates took 455.75 and 237.14 s. These large differences include host/cache variation and incoming main changes, so the campaign establishes coverage and duplicate-case reductions, without attributing a runtime speedup to its cuts. The final preservation review below binds the fully reconciled head and unchanged four-mutation evidence to its final scope.

Main #258 (`e44e77cefddf7288fb211e91d7d81b069f88bee9`) then landed updated command guides, their bundle and two CLI keeper declarations. It was merged normally as requested by the coordinator, preserving the new skills/brief regression cases and both AGENTS changes. The identical hold-help fix is now upstream, so final production savings against current main are 17 lines rather than the initial 16. The final table includes this main; its 1,369 declarations become 1,349. Final lint/typecheck and all 1,617 Bun cases pass in 142 files, zero failures, two snapshots and 13,757 assertions: 209.47 s Bun / 235.73 s complete verify sequence. Reconciled current-main runtime cases are 1,638 → 1,617 (−21). Dashboard production build and packed Node 22 install smoke pass again on the same production bytes. Final before/after verify is 432.51 → 235.73 s; prior equivalent observations above show why no speedup is attributed to the cuts. The final scope contains 48 branch/workspace identities across 47 paths; CLI production is now unchanged against main. The same single reviewer binds this final scope, counts and completed evidence before push.

## Durable ownership

The existing AGENTS test paragraph records three findings without adding lines: parser/reexport contracts have their original owner, and a negative performs its own operation with a positive prerequisite before excluding forbidden output. The campaign’s filtered worker/secrecy controls establish why the negative rule is needed. The API/bootstrap control and CI browser deadline also establish why costly fixture startup belongs in a separate bounded hook from the behaviour deadline.
