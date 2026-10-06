---
name: armada-runtime-herdr
description: Runtime guide for persistent Armada workers on this machine through herdr. Four sections cover launch, message, status, and stop with safe worktree archival.
---

Herdr keeps each worker in its own worktree and terminal pane on this machine, across coordinator restarts. Armada drives it by itself: `armada launch` creates the worktree and starts the harness, `armada answer` types into the pane, `armada status`, `armada inbox` and `armada watch` observe it, `armada peek` reads it, `armada relaunch` replaces a worker, and `armada merge` or `armada stop` remove a clean, pushed worktree. The raw `herdr` commands below are for reading a pane when Armada's view is not enough.

Run these on the machine that launched the worker, against the same herdr server. The claim stores `{workspace,pane,agent}`: recover it from `armada status --json` or the ticket's claim comment, never from memory. Requires herdr 0.9.1+, a supported harness already signed in (the owner runs `armada setup local` once), and an Armada coordinator sign-in. Never handle harness keys or sign-ins.

## Launch

```sh
armada launch ABC-12 --runtime herdr --profile backend --reason "back end work" --json
```

The profile in `[herdr.profiles]` selects the harness, model and effort; label routing wins, and a reason explains a choice or an override. `--harness claude|codex|opencode|deepseek` only checks the profile. DeepSeek profiles run OpenCode with the configured DeepSeek model. `--notes <file|->` and `--pre-approve` work as for any launch. The command checks the tools, creates a worktree, starts the harness and sends the brief; its JSON gives the `handle` and the worktree path, never the token. The worker signs in with its token, claims that handle and starts its heartbeat. A failed launch keeps the worktree for inspection. No claim after `[policy] not_started_minutes`: read the pane with `armada peek`, fix the cause, or `armada launch revoke ABC-12`.

## Message

```sh
armada answer <item> "Plan approved. Go on."
armada answer ABC-12 "<input for a live approval prompt or question>"
armada answer --note ABC-12 --message-file /tmp/abc-12-message.md
```

Armada checks the saved pane, types the text and Enter, then records the answer on the ticket and in the inbox, in one command; never type it a second time. Success means submitted, not acted on. A pane showing an approval prompt is a `runtime-blocked` inbox entry with no item id: read the pane, then answer by ticket with what it expects (often a short choice such as `y`). A delivery error leaves the question open; after a timeout, read the pane before retrying, since the input may have arrived.

A merge note that `armada merge` printed because it could not deliver it: check the current claim, its coordinator and phase, read the pane, and if the note did not arrive, send it with `herdr agent prompt <pane> "<printed note>"` (resolve a pending approval prompt first). Never record it with `armada answer --note`, which posts it on the ticket.

## Status

```sh
armada peek ABC-12
armada peek ABC-12 --json
```

Each `status`, `inbox` and watch poll reads the workers' panes from their claims and publishes what it saw to Armada; the dashboard shows that stored state. Peek shows the pane's state, its recent output, the worker's reports and heartbeat, the pull request's checks and open questions. A pane has no structured commands or exit codes, so peek's actions stay empty. A claim made on another machine shows its last stored state and age, and says the runtime is unreachable.

States: `working` is a running turn, `blocked` an approval or question prompt, `idle` and `done` are ready for input, `unknown` falls back to the worker's reports. Harnesses without native hooks (DeepSeek and others) report their phase to herdr on each report, ask and heartbeat.

For more than peek shows:

```sh
herdr agent get <pane>
herdr agent read <pane> --source recent-unwrapped --lines 120
```

Check that `workspace_id`, `pane_id` and `name` in `.result.agent` match the claim. Never paste credentials or whole transcripts into tickets.

**Relaunch** a stopped worker with `armada relaunch ABC-12 --reason "<why>"`. A clean worktree gets a new pane in place by default; `--in-place` keeps uncommitted files too. `--fresh` keeps the old checkout's branch, commits and files under an `armada-retained/` local branch, then creates a new checkout from the pushed ticket branch. The old pane is closed after the replacement starts. A pane on another machine is refused unless `--fresh --keep-old` is explicit: stop that pane on its machine.

## Stop and archive

`armada merge` removes the merged worker's worktree once GitHub confirms the merge. For a worker you stop without a merge:

```sh
armada release --ticket ABC-12 --reason "<why it stops>"
armada stop ABC-12
```

`armada stop` checks that the worktree belongs to this repository and the claim's branch. It refuses uncommitted or untracked files, a missing or unreachable upstream, and commits not pushed, and says what remains: push or keep that work, then retry, never force. It interrupts an active turn, waits for the pane to settle, checks again, then runs `herdr worktree remove` without `--force`. The branch stays. When a merge prints `armada stop …` after a failed cleanup, run that exact command.
