# Merging a pull request

`armada merge <pr>` merges one handed-back pull request and does everything around it. It checks the rules below, takes the project's merge lock, squash-merges pinned to the head it checked, confirms the merge on GitHub, records it on Armada, then closes the ticket in Linear and cleans up. When it refuses, fix the cause (usually: the worker fixes CI or a conflict and hands back again) rather than merging by hand.

## Read the result

Every run ends with one `Result:` line. Never pipe the command through `tail` or `grep`: read that line and what precedes it.

- `Result: merged #N`: merged, and the bookkeeping is done.
- `Result: not merged (…)`: no merge was confirmed; the worker and its workspace are untouched. If it says `merge unconfirmed`, GitHub may have accepted the attempt: look at the pull request before retrying.
- `Result: merged #N, Linear pending (armada merge --finish N)`: merged; finish Linear once it answers.
- A result naming `Armada and Linear pending`: run the printed `armada answer <hand-back id> "resolved: PR merged"` line as well as `--finish`.
- Merged at a different head from the one checked: the merge stands, the mismatch is printed, and nothing is recorded or archived. Check GitHub before finishing.

A confirmed merge exits 0 even with Linear pending. `--dry-run` runs the checklist only and ends `Result: not merged`. `--json` prints one object with the same text in its `result` field.

## What it checks

1. The worker handed back: phase `ready-to-merge`, with the full head SHA it reported. The pull request's head is that SHA, or that SHA with only the default branch merged in (a clean merge, checked with git).
2. GitHub says `CLEAN` (or `HAS_HOOKS`), not a draft, with a Commitizen title.
3. Every required check (`[gates] required_checks`, else all of them) passes, and no review thread is open.
4. The head contains the default branch, or a test merge passes `[gates] local_commands`.
5. No merge hold is open, unless you pass `--through-hold`.
6. With `[policy] merge_approval`, you judged it (below); a pull request sent to the owner needs their approval of that head.
7. With `[[acceptance]]`, the checklist lists the recorded acceptance passes on the head. The worker's hand-back already required them.

One check stays yours: search the default branch for callers of anything the pull request deletes or renames.

A confirmed merge clears that PR's open queue refusals and owner merge requests. The result line names the cleared item ids. A PR merged elsewhere clears those notices on the next inbox read from Armada's stored GitHub reading. Queued `--no-ticket` merges clear notices when the queue finishes; a direct `--no-ticket` merge clears them on that next reading when the refusal names the PR or the merge request carries its PR number. A failed cleanup write is a warning: GitHub's confirmed merge stays successful, and the stored reading retries resolution.

## Red checks on a pull request

`armada ci why <pr>` names the failing tests, shows the failed step and its test error excerpt, and explains runner problems. For unknown tests it prints up to three pasteable `[[ci.known_failure]]` blocks with exact-name patterns. Only declare a flake after it passed on a rerun of the same head: open the root-cause ticket first, then replace `<root-cause ticket>` (the parser rejects the placeholder). When no test name was found, write a specific pattern from the error lines. `armada ci why <pr> --rerun` reruns failed jobs once per completed first-attempt workflow run only when every failure is a runner problem or a declared `[[ci.known_failure]]`, and names each flake's root-cause ticket. Nothing reruns automatically. Send other failures back to the worker.

Network outages qualify as runner problems only in setup before tests/builds run, with validated step evidence. Container image pulls in `Initialize containers` qualify for Docker’s explicit `toomanyrequests`, auth timeouts and pull timeouts; successful `Stop containers` cleanup is allowed. Registry/auth 4xx stays a failure except that explicit Docker rate limit; any later project-step failure stays unsafe. Built-in setup steps are `Set up job`, `Initialize containers` and `Run actions/*`; declare other tool/dependency downloads as exact names or `*` globs in `[ci] setup_steps`. Without step evidence, the network error stays a failure; the CLI explains unavailable evidence or hints how to declare an undeclared setup step.

## After a confirmed merge

`armada merge` does these by itself, in order. Do none of them by hand.

1. **Records** the merge on Armada first, then closes the ticket in Linear: Done, agent labels removed, pull request linked, a merged comment saying how the merge was decided.
2. **Tells affected workers.** Workers whose open pull request shares files with what landed get a short "main moved" note through their runtime; changes to `[merge] notify_paths` (CI workflows by default) or an incomplete file reading concern every working pull request. Workers without a pull request, already handed back, or owned by another coordinator stay quiet, and the output says why. A note that could not be delivered is printed: deliver it in the worker's session with the runtime guide's manual commands, after checking the claim is still that worker's and an unknown outcome did not already arrive. Never send it with `armada answer --note`, which posts it on the ticket and resolves an open plan. `--no-notify` sends nothing and prints the list instead.
3. **Archives the merged worker's workspace** once GitHub confirmed the merge. `--no-archive` keeps it. A cleanup failure leaves the merge successful and prints the exact `armada stop <ticket> …` command to finish it; copy it whole.
4. **Closes the spec** when this was its last open ticket, with a summary, unless the team's parent auto-close does it. A failure there is a warning only.
5. **Lists unblocked tickets** under `Unblocked by <ticket>`: those ready to launch with their routed `armada brief <id> --prompt` command, those without a ready label, parked ones, and those that still wait on other blockers. Tickets you deferred with `armada launch --when-unblocked` are launched in the same run; one it cannot launch (a Claude Code profile, no ready label, a failed launch) keeps its request and prints the command to run.
6. **Starts the deploy check** for each matching `[[deploy.target]]` and prints `Watching the deploy of <sha> to <target>`. If it prints an `armada deploy watch …` command instead, run that in a persistent terminal.
7. Ends with the watch line: keep watching while workers are in flight.

## Main kept moving: `--wait`

Workers hand back without chasing main, and main moves between a green hand-back and its merge. Do not ask the worker to bring main in. Without `--wait`, a head that lacks commits of main is refused, except when GitHub does not require heads to be up to date (it does not say `BEHIND`) and `[gates] local_commands` is set: Armada then test-merges it locally and runs those commands. Run `armada merge <pr> --wait [--timeout <min>]` (30 minutes by default) in the background:

- In that test-merge case `--wait` test-merges too, so a busy main does not restart CI each time. Otherwise a behind head that merges cleanly is updated with GitHub's "update branch" (a merge commit, no force-push), its required checks are waited for, then it merges pinned to the new head. The updated head still counts as the hand-back.
- It holds the merge lock only while merging, so two waits never block each other.
- It stops at once on a red check, a conflict, an open hold, any refused rule, or when GitHub refuses the update. Send the cause to the worker; after an update, the worker pulls before pushing again.

## A queue: `--when-green` and `--drain`

When several pull requests are handed back, queue them instead of merging each by hand:

```sh
armada merge --when-green 12 15 --reason "CLI only"
armada merge --drain
```

- `--when-green <pr...>` records durable intent, in order, with each entry's `--reason`, `--no-ticket`, `--keep-open` or `--through-hold`. It refuses broken rules now and lets readiness (CI, a behind branch, an owner decision, a hold) wait. Queuing starts nothing.
- `armada merge --drain` merges the queue one entry at a time, in the background in a persistent terminal. Each behind branch is updated on GitHub and its checks waited for on that exact head (`[merge] queue_retest = "ci"`, the default; `"local"` uses `[gates] local_commands` instead), so the next entry always starts on the fresh main. Each merge runs every after-merge step above.
- An open hold pauses the drain and names it; an entry queued with `--through-hold` passes it. At `--timeout <min per entry>` a paused drain exits and the entry returns to the queue without counting an attempt: clear the hold once recovery is checked, then run the drain again. The queue stays in order: a fix queued behind a paused entry waits its turn, so remove the earlier entry first when the fix must go ahead. A refused rule removes that entry, leaves one `queue-refused` inbox item and goes on with the next: fix the cause and queue it again, which clears the item, or close it with `armada answer <id> "<why>"`.
- The owner's Merge button on the dashboard queues a pull request handed back at its current head: `queued_by` is the owner, and the reason, "merge asked on the dashboard by <owner>", serves as the `[policy] merge_approval` judgement. Any other press stays a `merge-request` for you. Queued entries with a free `merge-queue` lease and no change for 2 minutes show one `queue-stalled` item per stall: run `armada merge --drain`. The project page and `armada status` ("Merge queue") show the queue and the drain's current step.
- Temporary failures retry three times (after 1, 5 and 15 minutes). A killed drain resumes its entry, reading GitHub first so a merge is never done twice. One drain runs per project; `--json` prints one object per line.
- `armada merge queue` lists the queue and entries finished in the last day; `armada merge queue remove <pr>` removes one that has not started.

## The owner's merge rule: `--reason` and `--ask-owner`

`[policy] merge_approval` says in plain words which merges the owner approves first. Without it, merge on your own. With it, `armada merge` prints the rule; judge each pull request by its files and what users will see:

- It may merge on its own: `armada merge <pr> --reason "<why>"`, for example `--reason "CLI only"`.
- The rule keeps it for the owner: `armada merge <pr> --ask-owner --reason "<why>"`. It merges nothing. It puts the pull request (title, files, CI, preview, the ticket's screenshots) on the owner's Validations page and prints the approval link: send it with one question judged in about a minute, never a diff to read. Their decision arrives as a `decision` item; then `armada merge <pr>`. A new head, other than main merged in, needs a new approval.

## A ticket in several pull requests

A hand-back with `--more-prs "<what remains>"` is one part of its ticket. Merge it as usual: every check applies. After the merge the ticket returns to `implementing`, its worker stays signed in with its workspace, and Armada tells it to start the next part from the updated main. The final pull request, handed back without the flag, closes the ticket as usual. `armada merge <pr> --keep-open` keeps a ticket open when the hand-back did not say so; `--close` closes it despite the flag. Neither goes with `--no-ticket` or with the other.

## No ticket: `--no-ticket`

`armada merge <pr> --no-ticket` merges a pull request no ticket owns: the `armada init` pull request or a release pull request. Nothing is written to Linear; every other check stays. A branch named after a ticket is refused unless you add `--reason "<why the ticket stays open>"`, which is posted on the pull request. When none of the required checks ran on the head (a release pull request opened with the workflow's own token), it passes on GitHub's own state once the head is a minute old.

## Linear is down

After its retries, a Linear outage does not stop a merge when Armada holds an open hand-back for the same pull request and exact head: the command says `Linear did not answer; the hand-back was checked on Armada`. After the merge, the remaining Linear work becomes a `linear-pending` inbox item, `Finish Linear for #N`. Run `armada merge --finish <pr>` once Linear answers: it checks GitHub shows the merge, completes the ticket, and resolves the item. Repeating it writes nothing more; it also finishes a pull request merged by hand. Without a matching hand-back on Armada, the merge is refused and nothing is merged.

## Holds, main red and deploys

- `armada hold` lists the project's merge holds, shared by every coordinator; status, inbox and watch show them until cleared. They never expire.
- `armada hold add "<reason>"` pauses merges. `armada merge <pr> --through-hold "<why this fixes it>"` merges a fix and records the reason with every hold id; the holds stay open. After verifying the recovery, `armada hold clear <id> --reason "<what was verified>"`.
- `main red since #N` names the oldest failing merge since the last green commit and its failing checks; `a fix is running (#M)` follows when one is. A refreshed red main reading opens one `main-red` hold and wakes watch once per streak. It pauses single merges and the queue; merge the fix with `armada merge <pr> --through-hold "<why this fixes it>"`. The next green main reading clears that hold and its inbox item automatically. Running or absent checks leave it open. Clearing it by hand while main is red lets the next refresh reopen it. GitHub CI webhooks are needed for prompt detection; without refreshes no automatic pause opens.
- With `[[deploy.target]]`, each merge starts a watcher. A failed deploy or smoke check opens a `deploy` hold and one inbox item. `armada deploy status` shows each target; `not deployed (host skipped: …)` ends quietly, opens no hold and does not clear an ancestor’s failure. Retry a failed deploy with `armada deploy retry <target>`; use `--no-redeploy` to recheck after a redeploy on the host. Never `hold clear` a deploy hold before a recheck says healthy. Merge a code fix through the hold; the next healthy deploy of a commit that contains it clears the deploy hold by itself.
- `--no-lock` skips both the merge lock and the hold check. Use it only when Armada is down and you checked no other coordinator is merging.

## Live acceptance

`[[acceptance]]` declares live checks (a real build, a preview run) with their paths, timeouts and run caps. A worker runs `armada acceptance run` on its pushed head before handing back, and the hand-back is refused without a pass on that exact head. When a worker reaches the cap, judge the cause, then `armada acceptance allow <ticket> --runs 2 --reason "<why>"`.

## The release pull request

Some repositories publish through release-please: every merge opens or updates one release pull request (`chore(main): release <version>`, label `autorelease: pending`, a diff of the changelog, manifest and version fields only). Follow the repository's release rules (`AGENTS.md`).

- On a release train, leave it open: the scheduled run merges and publishes it. For an urgent fix, run the release workflow the rules name, for example `gh workflow run release.yml`.
- Where the rules ask you to merge it, use `armada merge <n> --no-ticket`. No CI runs on it and it often shows `UNSTABLE`; both are expected. Anything else in its diff, or `DIRTY`, is not: stop and tell the owner.
- After the release run, check the registry (for example `npm view <package> version`). If it did not publish, fix the cause and re-run the failed jobs of that run: a later push does not publish a version already tagged.

## By hand

Only when `armada merge` cannot run, and following the same checks:

```sh
gh pr merge <n> --squash --match-head-commit <full-sha>
```

- One merge at a time per project.
- Leave out `--delete-branch`: it deletes local worktrees that have the branch checked out, including other agents'.
- On a GitHub 5xx, check `gh pr view <n> --json state` before retrying.
- Then run `armada merge --finish <n>` to close the ticket, and `armada stop <ticket>` to archive the worker.
- Finally, for every target declared in `[[deploy.target]]`, run `armada deploy watch --sha <merge commit sha> --target <name>` in the background. Wait for its healthy deploy and smoke result before resuming normal merges; a failure keeps the deploy hold open. With no declared targets, there is no deploy check.
