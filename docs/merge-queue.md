# Main merge queue

This change prepares CI only. After it lands, a repository administrator enables
a ruleset targeting exactly `main` (not a wildcard), with **Require merge queue**,
**Require status checks to pass**, and squash as the queue's merge method.
Keep the existing review requirements. Select GitHub Actions as the expected
source for these exact check names:

- `Migration versions`
- `Lint, typecheck and test`
- `Golden PostgreSQL concurrency`
- `Golden OS recipe (actual provider image)`
- `Binary (linux-x64)`
- `Binary (linux-arm64)`
- `Binary (darwin-x64)`
- `Binary (darwin-arm64)`
- `Swift package tests and iOS simulator compile`
- `Migration dry-run (disposable database)`

This is the intended required list, not a claim about the current repository
settings. Reconcile any existing protection/rulesets with this list before
activation; do not require deployment or screenshot evidence checks.

Start with build concurrency **2**, merge limits **minimum 1 / maximum 1** PR,
only merge non-failing PRs enabled, and a **60-minute** status-check timeout.
This limits runner pressure while validating each candidate together with the
PRs ahead of it. Merge limits control merges, not the contents of CI builds.

Dashboard browser tests are manual-only for now (owner decision, 2026-11-12).
Run `bun run e2e` when browser validation is wanted; it is not a PR or merge-queue
gate. Screenshot evidence workflows are removed; their capture scripts remain.

## What runs in the queue

| Workflow file | Queue? | Reason |
| --- | --- | --- |
| `ci.yml` | Yes, all jobs | Same names and validation as PRs, including all four binaries. Migration versions compare the candidate against `merge_group.base_sha`, not `HEAD^`, to cover the entire queued group. |
| `apple-quality.yml` | Yes | Compile/test check, with no PR path filter so a required check always reports. Push path filtering is unchanged. |
| `migrations.yml` | Disposable preview only | No PR path filter; preview runs for PRs and queue candidates. Staging/production jobs retain their main-ref guards and cannot run on queue refs. No production credentials in preview. |
| `release.yml` | No | Publishes releases from main/tags or manual dispatch. |
| `staging-gated-production.yml` | No | Deployment/smoke on main, dispatch or explicit reusable call. |
| `post-deploy-smoke.yml` | No | Deployment event/manual smoke, not merge validation. |
| `production-health.yml` | No | Scheduled/deployment/manual monitoring. |
| `testflight.yml` | No | Main/manual distribution, not merge validation. |

Queue checkout uses the event's synthetic merge commit, never an individual PR
head. CI and Apple concurrency groups include event, queue ref and candidate SHA;
queue runs cannot cancel one another or PR runs. PR reruns still supersede older
runs. Migration previews have no shared concurrency group.

## Merging and recovery

After checks/reviews pass, a human or authorized merge agent uses:

```sh
gh pr merge <number> --squash
```

With the queue required, this enqueues the PR (or enables auto-merge until it is
eligible); it does not bypass queue validation. Do not use `--admin` or jump the
queue. A failed candidate is removed: fix the PR, rerun checks, then enqueue again.
Authors do not need to continually merge main just to satisfy queue freshness.

To roll back, an administrator disables the new queue ruleset and restores the
previous branch protections/required-check policy. Do not remove CI checks or
weaken validation to unstick a single PR. This is a settings rollback, not a
deployment or database rollback; no workflow changes are needed.

See [GitHub's merge queue guide](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)
for configuration semantics.
