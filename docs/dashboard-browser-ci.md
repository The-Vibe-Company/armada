# Browser CI measurements (#1269, slice 2a)

This is the measurement PR, not promotion to a required check. The workflow
**Dashboard browser measurements** runs on PRs, merge groups, main and manual
dispatch. Do not add any of its check names to the ruleset yet. Existing required
CI and its budget guard are unchanged.

The candidate uses 24 isolated jobs, one mock/app/browser worker in each. Playwright
fully-parallel sharding distributes individual tests rather than making the largest
spec one indivisible shard. A collection check selects **264 tests in 42 files**;
new tests are discovered automatically. Each shard uses zero retries and unchanged
test assertions. The pinned Noble container supplies system libraries; Chromium
comes from the installed lockfile version, not the container's old browser revision.

## Measurement and promotion

The previous single-worker CI measurement was 542 seconds of tests plus 26 seconds
container setup, 10 seconds install, 11 seconds Chromium and 27 seconds build/start.
24 shards target about 11 tests / 23 seconds of test work per shard. This is an
estimate, not a claim that any GitHub run meets the budget.

Each shard uploads its JSON report and failure traces under
`dashboard-browser-N`. Use GitHub's job timestamps for the **entire** job:
container initialization, dependency/browser installation, build/start, tests and
artifact upload. Also compare the final verdict to workflow start, including queues.
A three-minute diagnostic timeout leaves overruns visible rather than treating
termination at two minutes as success.

A full local zero-retry baseline was started before this PR; its ignored report
is under `plans/ship-pr-dev/browser-baseline/`. Real PR and merge-group runs are
the deciding evidence. The delivery owner does not poll CI; the coordinator reads
those timings. Only after every shard fits may the next PR add the required
**Dashboard e2e** aggregate and include its dependency chain in the budget guard.
If a shard fails or exceeds budget, repartition or document the offending spec
before promotion. Do not add retries, weaken assertions or silently omit tests.

Builds currently happen independently, in parallel, inside each shard. Sharing a
build would add a sequential build/upload/download dependency; the 118MB local
production output does not establish that sharing improves the critical path.
Keep this simple baseline until real measurements justify the extra stage.

## Explicit exclusions from the candidate gate

These remain in the full local `playwright.config.ts` suite; only the separate
measurement configuration excludes them. No test source is modified.

| Spec | Reason |
| --- | --- |
| resource-panel-focus.e2e.ts | Resource-panel focus/history lifecycle suite; quarantined with the fragile panel suites pending isolated stability measurements. |
| routines-panel.e2e.ts | Known fragile panel history/focus coverage called out in #1269. |
| tools-panel.e2e.ts | Known fragile panel history/focus coverage called out in #1269. |
| variables-panel.e2e.ts | Known fragile panel history/focus coverage called out in #1269. |

The four files account for 28 tests at this revision. Any additional failure gets
its own documented reason and evidence before it can be kept out of the gate.
