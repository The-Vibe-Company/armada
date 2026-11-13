# Main merge queue

This change prepares CI only. After it lands, a repository administrator enables
a ruleset targeting exactly `main` (not a wildcard), with **Require merge queue**,
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
| `migrations.yml` | No | Main migration changes or explicit operator dispatch only; apply jobs never appear on PRs. |
| `release.yml` | No | Publishes releases from main/tags or manual dispatch. |
| `staging-gated-production.yml` | No | Deployment/smoke on main, dispatch or explicit reusable call. |
| `post-deploy-smoke.yml` | No | Deployment event/manual smoke, not merge validation. |
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

To roll back, an administrator disables the new queue ruleset and restores the
previous branch protections/required-check policy. Do not remove CI checks or
weaken validation to unstick a single PR. This is a settings rollback, not a
deployment or database rollback; no workflow changes are needed.

See [GitHub's merge queue guide](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)
for configuration semantics.
