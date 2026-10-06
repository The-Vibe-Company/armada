# Merging a pull request

Run `armada merge <pr>` (add `--dry-run` to see the checklist only, `--wait` when main keeps moving, `--no-ticket` for a pull request no ticket owns). It checks everything below, takes the project's merge lock, merges pinned to the handed-back SHA, confirms the merge on GitHub, records it on Armada and then closes the ticket in Linear. Its output lists the workers in flight to tell and the worker workspace it archived. Add `--no-archive` to leave the workspace open. When a refusal names a rule, fix the cause (usually: ask the worker to bring the default branch in and report again) rather than merging by hand. When you must merge by hand, follow the same steps.

## Linear is down

After the shared retries, a temporary Linear outage does not stop a merge when Armada has an open hand-back naming the same PR and exact current full head SHA. The command says `Linear did not answer; the hand-back was checked on Armada`. It skips Linear's ticket-phase check and keeps the GitHub, CI, owner approval and merge-lock checks. Without that matching hand-back it refuses and says nothing was merged.

After GitHub confirms the merge, Armada records it first: the hand-back closes and the runtime claim is released. Linear's remaining work becomes a visible `linear-pending` inbox item: `Finish Linear for #N`, with `armada merge --finish N`. Run that command once Linear answers; it checks GitHub already shows the PR merged, completes Done/labels/link/merged-comment bookkeeping without a merge lock, and resolves the item. It also works for a PR merged by hand. Repeating it adds no more writes. You can close the inbox item by hand with `armada answer <item> "<what was finished>"`.

A merge through a hold keeps its override audit in the pending inbox item until `--finish` can post it to Linear. For a signed-in coordinator, finishing waits if Armada cannot supply that audit; it takes no merge lease and does not clear the hold.

Read the last stdout line before acting:

- `Result: merged #N`: the merge is confirmed and bookkeeping finished.
- `Result: not merged (…)`: no merge was confirmed; keep the worker's workspace. If it says `merge unconfirmed`, GitHub may have accepted the attempt: inspect the PR before retrying. It does not claim nothing was merged.
- `Result: merged #N, Linear pending (armada merge --finish N)`: the merge is confirmed; finish Linear later.
- When Armada's record also failed, the result names `Armada and Linear pending`. Follow the printed `armada answer <hand-back id> "resolved: PR merged"` recovery line as well as `--finish`.

If GitHub confirms a merge at a different head from the checked one, the result says merged with bookkeeping pending, prints the mismatch, and performs no automatic record or archive. Check it on GitHub before finishing or archiving.

A confirmed merge exits successfully even with Linear pending. An unfinished `--finish` exits nonzero so it can be tried again. `--json` keeps one JSON object and includes the same text in its `result` field. Dry runs and owner-approval requests end with `Result: not merged`.

## The owner's merge rule: `--reason` and `--ask-owner`

`[policy] merge_approval` in `armada.toml` says in plain words which merges the owner wants to approve first, for example "merge on your own, except front-end changes: send me a link to check them first". Without it you merge everything on your own. With it, `armada merge` prints the rule and you judge each pull request: look at its files and at what users will see, then record why either way.

- It may merge on your own: `armada merge <pr> --reason "<why>"`, for example `--reason "CLI only"`. The ticket's merged comment and the dashboard say `merged on its own (rule: …): CLI only`.
- The rule keeps it for the owner: `armada merge <pr> --ask-owner --reason "<why>"`, for example `--reason "touches components/timeline"`. It merges nothing: it records the pull request as GitHub shows it now (title, files with +/−, CI, the preview deployment of its head) with the ticket's screenshots on the owner's Validations page, posts the approval link (`https://<dashboard>/approve/<id>`) on the ticket and prints it. Send it to the owner. Their decision arrives in your inbox as a `decision` item (it wakes `armada watch`): approved, run `armada merge <pr>`, which records `approved by <owner> at <time>`; changes requested, relay them to the worker.
- Once the owner was asked about a pull request, `armada merge` refuses it until they approved that exact head; a head that is it with only main merged in still counts. Any other new head needs `--ask-owner` again.

## Main kept moving: `--wait`

With several workers in flight, main often moves between a green hand-back and its merge. Instead of asking the worker to bring main in, run `armada merge <pr> --wait [--timeout <min>]` (30 minutes by default), in the background where your runtime allows it (Claude Code: `run_in_background`):

- A head behind main that GitHub says merges cleanly is updated with GitHub's "update branch": a merge commit on the branch, no force-push. Squash merges make that merge commit harmless. When main does not require heads to be up to date and `[gates] local_commands` is set, it is test-merged instead, as without `--wait`, so a busy main does not restart CI each time.
- It waits for every required check on the new head, then merges pinned to that head.
- It holds the project's merge lock only while merging, not while waiting, so two waits never block each other. Signed in with Armada down, it refuses before touching the branch.
- It stops at once, naming the cause, on a red check, a conflict, any other refused rule, or when GitHub refuses the update (a branch protection rule or ruleset can forbid it) or accepts it without the head moving within 3 minutes: ask the worker to fix it. A refusal after an update says so: the worker pulls the updated branch before pushing again.
- The updated head still counts as the worker's hand-back, because the only change is main coming in: `armada merge` accepts a head that is the handed-back SHA followed only by merge commits, each bringing in a commit of main, with the tree of a clean merge (checked with git). That holds without `--wait` too, for example after "Update branch" on GitHub. The ticket's merged comment names both heads: `head <new>, the handed-back <old> updated with main`.

## A ticket in several pull requests

A hand-back with `--more-prs "<what remains>"` tells Armada this PR is one part of the ticket. Run the normal `armada merge <pr>`: all SHA, CI, review, merge-lock and owner-approval checks still apply to this PR. After the confirmed merge, the ticket returns to `implementing` and stays open, the hand-back is resolved, and its worker stays signed in with its workspace and questions intact. Only the final PR counts as a merged ticket in insights. If Linear is unavailable, the confirmed partial merge still retains its worker and records the next part in the pending Linear chore; `armada merge --finish <pr>` repairs it as `implementing`, preserving the partial intent.

Armada delivers the next-part message to the same active worker through its runtime adapter. If delivery is unavailable it prints the message; if the outcome is unknown, inspect the session before delivering it yourself. The worker starts the next branch from updated main, keeps its existing claim and hands back the final PR without `--more-prs`. That final merge closes and archives as usual. Partial merges list no newly unblocked tickets and launch no dependents.

Use `armada merge <pr> --keep-open` to keep a ticket open even when its hand-back omitted the flag; use `--close` to close despite it. The flags cannot go together or with `--no-ticket`. Queuing with `--when-green --keep-open` persists that intent; otherwise the hand-back decides when the queue drains. `--close` is for an immediate merge; the queue does not store a close override.

## No ticket: `--no-ticket`

`armada merge <pr> --no-ticket` merges a pull request no ticket owns: the `armada init` pull request (its output names the command) or the release pull request below. There is no hand-back and nothing is written to Linear; every other check is unchanged, and the merge is pinned to the head it checked. A branch that names a ticket of the program is refused unless you add `--reason "<why the ticket stays open>"`. Use that override for pull requests nobody handed back, such as configuration work on a ticket-named branch: it requires the configured CI checks, posts the reason on the PR before merging, and leaves the ticket and its worker unchanged. A failed reason comment refuses the merge; `--dry-run` posts nothing.

When none of the required checks ran on the head (a release pull request opened with the workflow's own token gets no CI run), it passes with a note, on GitHub's own state (`UNSTABLE` included, when nothing failed) and the checks that did run, once the head is a minute old; a younger head, or a head this run updated (its update starts CI), is waited for (`--wait`) or refused.

## Default-branch CI

`armada status` and the dashboard read the default branch's last 20 commits. "main red since #N" names the oldest failing merge since the last green commit, with its failing checks and short SHA; a running commit on top adds "a fix is running (#M)". Unchecked commits, including releases, neither start nor end the streak. With no green boundary in the history window, the reading says "red for more than 20 commits" instead of blaming an unproven first merge. A direct commit uses its short SHA when no squash PR number is available.

Configured `[gates] required_checks` decide health; without them, GitHub's rollup does. A green reading clears the warning. Older snapshots have no reading until the next GitHub refresh. `armada merge` includes the red reading as a note only. The shared merge pause and coordinator wake-up are added separately by THE-1104; this reading alone does not block a merge. THE-1102's queue can use the same fresh `mainHealth` adapter.

## Live acceptance

`[[acceptance]]` in `armada.toml` declares live checks (builds or preview runs), their paths, timeouts and per-ticket run caps. Workers bring main in, then run `armada acceptance run` on a clean, pushed PR head before hand-back. Linear carries attempts and passes, so the hand-back gate works with Armada down. `armada merge` lists the recorded acceptance passes on the head or the original handed-back head. This is informational: `--wait` may merge main into a head the worker already proved. During the Linear-outage fallback, the checklist names applicable checks and says their Linear evidence is unavailable; the exact Armada hand-back remains usable. At a run cap, judge the cause and use `armada acceptance allow <ticket> --runs 2 --reason "<why>"` to grant two additional attempts to each check on that ticket. Workers cannot grant themselves more.

## Before

1. The worker has handed back: `Agent phase` is `ready-to-merge` and you have the full 40-character head SHA it reported.
2. `gh pr view <n> --json headRefOid,mergeStateStatus,isDraft,title` shows that SHA (or that SHA with only main merged in), `CLEAN` (or `HAS_HOOKS`), not a draft, and a Commitizen title.
3. `gh pr checks <n>` shows every required check passing. When a check is red, run `armada ci why <n>` first: it names failing tests, first errors and runner problems; external apps show their summary and link. `--branch main` diagnoses the default branch when it is named main. Add `--rerun` only when every failing check of a workflow run is a declared `[[ci.known_failure]]` or runner problem: a completed first attempt may rerun its failed jobs once. The output names the root-cause tickets; include them in the next report. Unknown/external failures, incomplete evidence and attempt 2 or later are refused; fix the cause, with no force override. An uncertain rerun outcome needs a GitHub read before any further action.
4. The head contains the current default branch: `git merge-base --is-ancestor origin/<default> <sha>`. If not, update it (`--wait`) or ask the worker to bring the default branch in (rebase, or merge it into their branch; never force-push a branch someone else pushed to).
5. Semantic check: search the default branch for callers of anything the pull request deletes or renames.
6. A dashboard pull request (one that changes Armada's own dashboard, `packages/dashboard`): compare with the owner's design, `design/dashboard-v7/Armada Dashboard.dc.html`. Open each page it changes on its preview or the demo next to the design's screen and the overview (`/`). The header bar, the page's title line, its lists and rows must match them. A page with a title of its own outside that anatomy, another font or its own list style goes back to the worker.

## Merge

```sh
gh pr merge <n> --squash --match-head-commit <full-sha>
```

- One merge at a time: `armada merge` holds the project's merge lock. If it refuses because Armada is down, use `--no-lock` only when you are sure no other coordinator merges in the project.
- Leave out `--delete-branch`: it deletes local worktrees that have the branch checked out, including other agents'. Delete the branch once its worktree is gone.
- If GitHub answers with a 5xx, check `gh pr view <n> --json state` before retrying.

## After

With `[[deploy.target]]` declared, `armada merge` starts a detached deploy watcher per matching target after ending worker sessions. It prints `Watching the deploy of <sha> to <target>` and returns. If it prints `armada deploy watch …` as the next step, run that command in a persistent terminal. `armada deploy status` shows target states and deploy holds; status and the next merge flag watchers with no recent news. A deployment failure, smoke failure or timeout puts one item in your inbox and pauses merges by default. Merge the fix with `--through-hold "<what this repairs>"`; the next healthy deploy clears covered deploy failures automatically. Do not clear the hold first. Manual holds and other targets remain independent. No deploy target: existing merge behavior is unchanged.

1. The ticket is Done, its `Agent phase` and `Agent runtime` labels removed, the pull request linked.
2. Tell every in-flight worker what the merge changes for them: a shared file, a migration, a new check, code they must now reuse or delete.
3. `armada merge` archives the merged worker's workspace after GitHub confirms the merge. Archive only after the final `Result: merged #N` line confirms it landed (including a result with bookkeeping pending). A `Result: not merged (…)` line means keep the workspace. If cleanup fails, the merge still succeeds and prints the exact `armada stop <ticket>` command to finish it. `--no-archive` leaves the workspace open; shared workspaces and the coordinator's own workspace are retained.
4. Read `Unblocked by <ticket>` in the merge output (also `unblocked` in `--json`): it names tickets ready for an agent, those without a ready label and those parked. Use each ready ticket's printed `armada brief <id> --prompt` command, with its routed profile when configured, to launch it. `now waits only on` names dependents that still have open blockers. A no-ticket merge lists no unblocked tickets.

## The release pull request

Some repositories publish through release-please: every merge to the default branch opens or updates one release pull request, and merging it tags the version and publishes it. Follow the repository's release rules (`AGENTS.md`). When they specify a release train, leave the release pull request open after each ticket's merge: the train merges it at the scheduled time and tags and publishes in the same run. One release pull request carries everything merged since the last release.

- **What it looks like.** Title `chore(main): release <version>`, opened by `github-actions`, label `autorelease: pending`, and a diff that only touches the changelog, the manifest and version fields. It is opened with the workflow's own token, so **no CI check runs on it** (only checks from apps such as Vercel, if any) and `mergeStateStatus` is often `UNSTABLE` (`armada merge --no-ticket` accepts it when none of the required checks ran and nothing failed). Both are expected: the publish job runs the repository's checks again before publishing. Anything else in the diff, or a `DIRTY` state, is not expected: stop and tell the owner.
- **Find it and its head:**

```sh
gh pr list --state open --label "autorelease: pending" --json number,title,headRefOid,mergeStateStatus
```

- **Urgent fix on a release train.** Run the release workflow named by the repository's rules, for example:

```sh
gh workflow run release.yml
```

The workflow merges the pending release pull request and publishes it at once. Use this only when the repository's rules allow a manual release; ordinary ticket merges wait for the train.

- **Repositories without a train.** Only when the repository's rules ask the coordinator to merge release pull requests, use `armada merge <n> --no-ticket`: no ticket owns it, and no required check runs on it (see "No ticket" above). A manual merge must still pin the checked head and leave out `--delete-branch`.
- **Check the publish.** After the scheduled or manual Release run finishes, check the registry, for example `npm view <package> version` for an npm package (the package is named in `AGENTS.md` or the release workflow). If it is not published, open the Release run (`gh run list --workflow release.yml --limit 3`, using the repository's workflow name), fix the cause and re-run its failed jobs: a later push does not publish a version already tagged.

## Paused merges

`armada hold` lists the project's persistent merge pauses, shared by every coordinator. Manual pauses, failed deploys and red main use the same holds. They never expire. `armada status`, `armada inbox` and `armada watch` show an open hold until it is cleared.

- Pause with `armada hold add "<reason>"`.
- Merge the fix with `armada merge <pr> --through-hold "<why this fixes the pause>"`. This passes every open hold and records the reason with every hold id in the ticket's merged comment. The holds stay open while the fix is checked.
- After verifying recovery, resume with `armada hold clear <id> --reason "<what was verified>"`. Clear every open hold to resume normal merges. Repeating a clear names who cleared it and when.

A single merge refuses on any open hold, including during `--wait`: a pause needs a decision, so the command stops on its next poll. `--no-lock` also skips reading holds and says so; reserve it for recovering from an unavailable Armada when you have checked the project's state yourself.
