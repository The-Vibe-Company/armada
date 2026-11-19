# Main merge queue

A repository administrator owns the ruleset targeting exactly `main` (not a wildcard), with **Require merge queue**,
**Require status checks to pass**, and squash as the queue's merge method.
Keep the existing review requirements. Select GitHub Actions as the expected
source for these exact check names:

- `Lint, typecheck and test`

This is the single required verdict. The coordinator has configured the ruleset;
do not add optional iOS, migration previews or deployment checks to it.

Start with build concurrency **2**, merge limits **minimum 1 / maximum 1** PR,
only merge non-failing PRs enabled, and a **60-minute** status-check timeout.
This limits runner pressure while validating each candidate together with the
PRs ahead of it. Merge limits control merges, not the contents of CI builds.

Dashboard browser tests are manual-only for now (owner decision, 2026-11-12).
Run `bun run e2e` when browser validation is wanted; it is not a PR or merge-queue
gate. Screenshot evidence workflows and their one-off capture scripts are removed.

## What runs in the queue

| Workflow file | Queue? | Reason |
| --- | --- | --- |
| `ci.yml` | Yes | Six unit shards (shard 1 also runs lint/typecheck and migration guards), plus their aggregate. Native/namespace contracts run in release validation. Migration versions compare the entire candidate against `merge_group.base_sha`. |
| `apple-quality.yml` | No | Optional PR/main workflow filtered to iOS and its generated harness contract inputs. GitHub merge-group events do not support workflow-level path filters. |
| `migration-preview.yml` | No | Optional PR dry-run, filtered to `supabase/migrations/**`, with no production credentials. |
| `migrations.yml` | No | Manual main-only previews/history/owner repair. Production SQL applies only through a validated publishing release, never this standalone workflow or PRs. |
| `release.yml` | No | Publishes releases from main or by version and SHA from a main workflow dispatch. |
| `staging-gated-production.yml` | No | Deployment/smoke on main, dispatch or explicit reusable call. |
| `post-deploy-smoke.yml` | No | Main-only manual pinned smoke, not merge validation. |
| `production-health.yml` | No | Scheduled/deployment/manual monitoring. |
| `testflight.yml` | No | Main/manual distribution, not merge validation. |

Queue checkout uses the event's synthetic merge commit, never an individual PR
head. CI concurrency groups include event, queue ref and candidate SHA;
queue runs cannot cancel one another or PR runs. PR reruns still supersede older
runs. Migration previews cancel stale runs per PR.

## Merging and recovery

After checks/reviews pass, a human or authorized merge agent uses:

```sh
gh pr merge <number> --squash
```

With the queue required, this enqueues the PR (or enables auto-merge until it is
eligible); it does not bypass queue validation. Do not use `--admin` or jump the
queue. A failed candidate is removed: fix the PR, rerun checks, then enqueue again.
Authors do not need to continually merge main just to satisfy queue freshness.

### Releases do not freeze merges (#1850)

Keep enqueueing and merging green PRs while a publishing release runs. Do not
pause the queue to protect its staging commit: staging ownership, not main's
branch tip, protects the exact-release smoke. The release checks out its validated
SHA and production requires that call's successful smoke; newer main commits do
not change either source or authorize production.

`staging-gated-production.yml` serializes **all** staging writers with the
`post-deploy-smoke-staging` job concurrency group (`queue: max`, no cancellation).
The lock covers migration, server/dashboard deployment, smoke and receipt upload.
An ordinary main job waits while the release holds that lock. Its outer
`staging-main-latest` group retains the newest pending ordinary run; the final
admission guard also skips superseded main SHAs before any mutation. Once the
release releases staging, ordinary work resumes with the latest main. Pinned
release/manual calls are not superseded. An ordinary job already holding staging
finishes before a waiting release; never cancel it to accelerate the release.

This is steady-state operation, not permission to skip the one-time provider
writer cutover/drain in [releasing](releasing.md#owner-cutover-prerequisites-no-agent-performs-these-operations).
No ruleset change, new CI job or required check is needed. If an independent Git
provider writer is still enabled, stop and have the owner complete that cutover;
a merge freeze is not a substitute for exclusive staging ownership.

Owner acceptance evidence (not yet verified for #1850): during an authorized
release, record the release run URL and exact SHA, a PR URL and merge timestamp
inside that run's staging lock interval, and the following latest-main staging
run URL/SHA. Confirm the release and following ordinary smoke both succeed,
with no ordinary deployment inside the release lock interval. Record the
release's successful exact-SHA smoke as the production prerequisite, not an
ordinary smoke. This observation needs a real release; local checks and merged
workflow code cannot establish it. Agents must not deploy to manufacture proof.

To roll back, an administrator disables the new queue ruleset and restores the
previous branch protections/required-check policy. Do not remove CI checks or
weaken validation to unstick a single PR. This is a settings rollback, not a
deployment or database rollback; no workflow changes are needed.

See [GitHub's merge queue guide](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)
for configuration semantics.

## Bounded CI checkout and branch retention (#1796)

Unit shards check out one commit. Only shard 1 fetches additional objects for
migration comparison: the current PR base tip, the exact merge-group base SHA,
or the push's previous SHA, each at depth 1 without tags. Manual dispatch fetches
only two commits to expose the checked-out commit's first parent. The migration
guard uses `ls-tree`, not a merge base, so it needs trees rather than full history.
No job or required check is added.

Baseline: [CI run 43594826771](https://github.com/The-Vibe-Company/armada/actions/runs/43594826771)
(2026-11-14, SHA `4c2a00f778b3cdf4168f9fba1442436e58b48eb3`) measured
shards 1–6 at **72, 56, 53, 49, 52, 64 seconds**, respectively, using job
`completed_at - started_at`; shard 1 checkout was 4 seconds. After-change timing
must be collected from the PR's completed run using the same fields. It is not
available before pushing; do not substitute a local benchmark or claim that
checkout accounts for all shard imbalance.

### Owner recommendation: retain automatic deletion, reconcile conservatively

The repository API reports `delete_branch_on_merge: true`. This setting is not a
retroactive branch garbage collector: it cannot remove branches recreated by a
later coordinator push. GitHub also documents that branch protections/rulesets
can prevent deletion, and fork PRs use the fork's setting, not this repository's
setting. See [automatic branch deletion](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-the-automatic-deletion-of-branches).
The coordinator observed 731 surviving exact heads of merged PRs (#1796),
including merge-queue/coordinator branches. That establishes failed cleanup,
not which deletion exception or subsequent push caused each retained ref;
there is no evidence here that merge queue universally disables deletion.

Cheapest durable fix (owner decision, no new CI job): keep the setting enabled,
check that deletion restrictions target `main` rather than worker branches, and
have the existing coordinator reconcile source refs after it observes a completed
merge (enqueueing is not merging). Delete only a same-repository, non-default,
non-protected ref whose current SHA still equals the merged PR's recorded head
SHA, with no open PR using it as head or base. Skip changed/reused refs and
report failures; never blindly delete by branch prefix or `git branch --merged`
(squash merges do not preserve ancestry). Stop workers pushing after completion.
If coordinator reconciliation is unavailable, an owner-approved scheduled cleanup
is an alternative, not part of this patch. Do not weaken main's protections.
