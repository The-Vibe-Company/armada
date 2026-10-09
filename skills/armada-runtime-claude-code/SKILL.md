---
name: armada-runtime-claude-code
description: Runtime guide for running Armada workers as local subagents of a Claude Code coordinator. Use when an Armada coordinator running in Claude Code must launch a worker on a ticket with the Agent tool, send it a message, check whether a silent worker is still alive, or stop it and clean up its worktree. Four fixed sections, each with the exact tool call and how to read its result.
---

A Claude Code coordinator can run workers as its own background subagents (the Agent tool). Armada cannot reach them, so it does none of the runtime work for them: `armada launch` points here, `armada answer` records an answer but does not deliver it, `armada peek` shows only the stored reports, and neither `armada merge`, `armada stop` nor `armada relaunch` can stop or clean one up. You do those steps with the tool calls below. Everything else works as for any worker: the claim, reports, the inbox, `armada watch` and the merge checks. Checked against Claude Code's Agent, SendMessage, TaskStop and EnterWorktree tools as of October 2026; if a parameter is refused, read the tool's own description and adapt.

- **A subagent lives inside your session.** Closing the terminal, a crash or the end of a cloud machine stops every worker launched this way, mid-turn. Use this runtime for short tickets you will see through in one sitting; anything that must survive you goes to Conductor or herdr.
- **Always in its own worktree.** Without `isolation: "worktree"` a subagent edits your checkout and switches your branch under you. Never launch one without it.
- Its Armada handle is its name: the ticket id in lowercase (`abc-12` for ABC-12), which the brief's claim line already uses.
- **It shares your machine and environment**: your `gh` sign-in, your `armada`, every variable of your session. Its brief carries a one-time launch token, so it needs no key; because it inherits your environment, the brief tells it to pass `--ticket` to every command.
- Check the stop-hook banner on coordinator commands and `armada doctor`. Your session registers when you run `armada inbox` or `armada watch`, so the hook holds you across checkouts while workers are in flight and no watch runs. If your session starts outside the coordinator checkout, install `armada hook stop 2>/dev/null || true` as a Stop command in `~/.claude/settings.json`; init only edits repository settings. An installed hook confirms at your next turn end. Workers with `ARMADA_TICKET` never register; worker subagents fire SubagentStop, which does not hold the coordinator.
- `armada watch` bounds itself to 100 minutes under `CLAUDECODE`, or 90% of a shorter observed external lifetime (minimum five minutes). `--for <minutes>` overrides it. Start it again on the timeout notification. A second plain watch waits for the holder's result; keep each watch in a tracked background Bash call, never `&` inside a foreground command.
- A worker's question, plan or hand-back reaches your inbox, not your conversation: keep `armada watch` running in the background as the coordinator skill says. The notification Claude Code sends when a subagent stops is a hint to look, not the record.

## Launch

1. Choose the profile as the coordinator skill says. It must have `runtime = "claude-code"` in `armada.toml`. The Agent tool does not apply the profile's effort: a worker that needs one goes to Conductor.
2. **One brief call:** `armada brief ABC-12 --prompt --profile-line`, with the chosen `--profile`, `--reason`, `--pre-approve` and validation flags. Stdout is the exact worker prompt and its one-time token; stderr names the profile, model and reason. Resolve its warnings first. Human and `--json` views carry no token. The token works once, within the hour: if you do not launch, run `armada launch revoke ABC-12`.
3. Launch with the Agent tool, every value set, the prompt being that output followed by anything only you know:

```json
{
  "description": "ABC-12 <short title>",
  "name": "abc-12",
  "prompt": "<the whole armada brief --prompt output, then your notes>",
  "subagent_type": "general-purpose",
  "model": "<the profile's model, e.g. opus>",
  "isolation": "worktree",
  "run_in_background": true
}
```

- `isolation: "worktree"` gives it a worktree under `.claude/worktrees/` on a new branch; the brief has it renamed to the ticket's branch. Add `.claude/worktrees/` to `.gitignore`.
- `run_in_background: true` returns at once, so you keep coordinating.
- `name` is the handle in the brief. If your Agent tool has no `name`, record the returned `agentId` at once with `armada answer --note ABC-12 "subagent <agentId>"`, so the ticket leads back to it.
- Keep the returned `agentId` and `output_file` (the transcript). Never read that file whole.

The worker runs its heartbeat in its own background Bash, without `--background`, so it dies with the subagent, as intended.

**Check the claim** a few minutes later: `armada status` shows the ticket in flight, runtime `Claude Code`, session `abc-12`. A `not-started` entry says whether the worker never used its token or signed in and stopped; read its transcript (Status). A refused token needs a fresh `armada brief ABC-12 --prompt`; message the worker only its `armada login --launch-token …` line.

## Message

```json
{ "to": "abc-12", "summary": "ABC-12 plan approved", "message": "Plan approved. Go on." }
```

SendMessage reaches the worker by name (or `agentId`). A running worker gets it at its next tool call; a finished one is resumed from its transcript, in its worktree. Delivered is not acted on: check its status and reply. Then record it, once: `armada answer <item> "<answer>"` for an inbox item, `armada answer --note ABC-12 "<message>"` for anything else. `armada answer` does not deliver to Claude Code, so the worker gets it only once. A merge note `armada merge` printed for this worker is delivered the same way, and never recorded with `armada answer --note`.

## Status

Three readings, cheapest first:

- **ListAgents** lists your running subagents: `abc-12 · general-purpose · running · started 4m ago`. A worker not listed has ended its turn: it handed back, waits for an answer, or stopped. If `armada status` does not show it `ready-to-merge`, `awaiting-approval`, `awaiting-validation` or `blocked`, it stopped: read its last reply, then message it to go on, or stop it and release the ticket.
- **The task notification** when a subagent stops: `completed` (its turn ended) or `killed`, with its final reply.
- **Its transcript**: when it was last written, and its last events. A running worker whose transcript has not moved for twice `policy.silence_minutes` is stuck: message it, then stop it if it does not answer.

```sh
f=<output_file>
date -u -r "$f" +%FT%TZ
tail -n 200 "$f" | jq -r 'select(.type == "assistant") | .message.content[] | select(.type == "text") | .text' | tail -n 40
tail -n 200 "$f" | jq -r 'select(.type == "assistant") | .message.content[] | select(.type == "tool_use") | .input.command // .name'
```

If a filter prints nothing, count the event types (`tail -n 200 "$f" | jq -r '.type' | sort | uniq -c`) and adapt.

## Stop and archive

A subagent has no workspace: archiving it means stopping it and removing its worktree. `armada merge` cannot do it; do it after the merge's `Result: merged` line, or after a release.

1. Stop a worker that runs the wrong thing, or one you release, with TaskStop: `{ "task_id": "abc-12" }`. The notification names its `worktreePath` and `worktreeBranch`; the worktree and its changes stay.
2. A worker that did not hand back: `armada release --ticket ABC-12 --reason "<why>"`.
3. Once it no longer runs (ListAgents), from your own checkout:

```sh
git worktree list                               # the worker's path and branch
git -C .claude/worktrees/<dir> status --short   # what would be lost
git worktree remove --force .claude/worktrees/<dir>
git branch -D <the worker's local branch>       # the pull request and remote branch stay on GitHub
```

A worktree the worker never changed is removed by Claude Code when the subagent ends.

## A worker without a worktree

A subagent launched without `isolation: "worktree"` runs in your checkout. Its brief makes it check `git rev-parse --show-toplevel` first and, outside `.claude/worktrees/`, call `EnterWorktree` before touching a file; if Claude Code refuses, it changes nothing and ends its turn. Then check your own checkout (`git status --short`, `git branch --show-current`), move anything it changed to a new worktree, stop it, and launch it again under the same name with `isolation: "worktree"`. A worker that had claimed claims again from the same handle.
