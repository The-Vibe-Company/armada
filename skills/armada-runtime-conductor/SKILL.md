---
name: armada-runtime-conductor
description: Runtime guide for running Armada workers on Conductor Cloud. Use when an Armada coordinator must launch a worker on a ticket, send it a message, check whether a silent worker is still alive, or stop and archive it. Four fixed sections, each with the exact conductor command and how to read its output.
---

Armada drives Conductor workers by itself, through the `conductor` command line tool:

| Step | Armada command | What it does |
| --- | --- | --- |
| Launch | `armada launch` | creates one workspace and session with the brief |
| Deliver | `armada answer`, `armada answer --note` | sends the text into the session, then records it |
| Observe | `armada status`, `armada inbox`, `armada watch` | read the session's state before calling a worker silent |
| Peek | `armada peek` | the last reply, recent commands, checks and questions |
| Replace | `armada relaunch` | a new session on the same branch and pull request |
| Archive | `armada merge`, `armada stop` | archive the workspace after a merge or release |

This guide says how to read what they print, and keeps the raw `conductor` commands for when Armada cannot act: the appendices at the end. The coordinator must be signed in to Armada (`armada login`) and to Conductor.

- On a Mac, the app ships the CLI at `/Applications/Conductor.app/Contents/Resources/bin/conductor`, not on PATH; `armada doctor` prints the fix. In a Conductor Cloud workspace it reads `CONDUCTOR_API_KEY` and needs no login. `conductor auth whoami` checks the sign-in (exit 0 when it works); `conductor auth status` only looks at the macOS Keychain.
- A worker is one workspace with one session. Its Armada handle is `<workspaceId>/<sessionId>`: the claim comment carries it, so `armada status` and the ticket lead back to the session.
- A worker needs no key in its workspace: its brief carries a one-time launch token, exchanged at its first command for a session limited to its ticket. Never pass keys through Conductor's `--env`.

## Launch

```sh
armada launch ABC-12 --runtime conductor --profile <name> --reason "<why>" --notes notes.md
```

- `--profile` and `--reason` are needed only when routing does not settle the profile. Add `--pre-approve` (its reason is the same `--reason`) when the plan needs no review.
- `--notes <file|->`: context only you have, up to 16 KB. Notes never approve a plan; the brief's Plan line decides.
- `--dry-run` checks the ticket, the profile and the Conductor sign-in, and creates nothing.
- The command refuses a ticket already launched or claimed, takes a launch lease, mints the token, and creates one workspace with the profile's agent, model, effort and fast mode, the brief passed on stdin. `[conductor] project_id` picks a Conductor project instead of the repository URL; `base_branch` overrides the default branch. It prints the profile, the `<workspaceId>/<sessionId>` handle and the session link, never the token.
- A known failure revokes that token. A lost answer is recovered by searching for the workspace, never by creating it again; when the search is not conclusive, the launch stays pending and the output names the candidates and the commands to settle it. Never launch the same ticket a second time before reading that output.

The brief makes the worker start `armada heartbeat --every 5m --parent "$PPID" --background` right after its claim: a detached process that pings Armada until the worker's agent process exits or its session ends. A worker waiting on you (`awaiting-approval`, `blocked`, `awaiting-validation`) needs no heartbeat; after your answer it reports its working phase and restarts the heartbeat.

**Check the claim** a few minutes later: `armada status` lists the ticket in flight with runtime `Conductor` and the printed handle. No claim after `[policy] not_started_minutes` (ten by default) gives a `not-started` inbox entry, which says whether the worker never used its token or signed in and stopped before claiming. Read it with `armada peek ABC-12`. A worker stuck on a setup choice gets a note to take the safe option. A refused or expired token needs a new one: run `armada brief ABC-12 --prompt` and send the worker only its `armada login --launch-token …` line (manual message, below). A worker cut off from Armada was revoked or idle for three days: ask the owner before giving it a new token. A worker that is gone: `armada relaunch ABC-12 --reason "never claimed"`, or `armada launch revoke ABC-12`.

## Message

```sh
armada answer <item> "Plan approved. Go on."
armada answer --note ABC-12 "<a message the worker did not ask for>"
armada answer <item> --message-file /tmp/abc-12-answer.md
```

One command delivers the text into the worker's session, posts it on the ticket and records it on Armada; an answer resolves its question or plan. The receipt says `queued` when a turn is still running: accepted is not read, so check the reply with `armada peek`.

- After a failure, run the same command with the same text: Armada reuses the message id and Conductor delivers it once. Changed text is a new message.
- A question older than the current worker, an ended claim or a replaced launch is refused before anything is sent. An archived workspace cannot receive messages: relaunch the worker.
- A launch bound to its session can receive notes before its claim.
- Never follow an `armada answer` with a manual send of the same text, or the other way round: the worker would get it twice.

## Status

Armada reads each worker's session itself, before `armada status`, `armada inbox` and each watch poll, when the heartbeat is older than half of `policy.silence_minutes` (at most every five minutes per session). A session still `working` is called silent only past twice the allowance, and the alert says it is working. A session `idle` in a working phase for five minutes without a report or answer is `stopped`. An archived workspace ends its claim. Without a usable Conductor CLI, the plain silence rule applies.

```sh
armada peek ABC-12
armada peek ABC-12 --actions 10 --json
```

Peek shows the session's state and since when, the worker's last reply, its recent commands and exit codes, its report and heartbeat ages, the pull request's checks and open questions, in your `TZ`, with secrets masked. It reads a bound launch before its claim too, and never writes to the worker. Repeated peeks read only what is new.

- `working`: a turn is running; leave it unless it stays silent past twice the allowance.
- `idle`: the turn ended. If the worker is not `ready-to-merge` or waiting on someone, it stopped: compare its last report with its reply, then nudge it with `armada answer --note`.
- `failed`: the last turn failed. Nudge it once; if it fails again, relaunch.
- `archived`: the workspace ended; its transcript can still be read.

**Relaunch** a dead, failed or stuck worker:

```sh
armada relaunch ABC-12 --reason "session failed twice"
```

It stops the old session, releases only that worker's claim, launches a replacement on the same branch and pull request, then archives the old session. A ready workspace is reused in place by default (a new session, uncommitted files kept); a failed or gone one gets a fresh workspace from the pushed branch. `--in-place` or `--fresh` choose; `--keep-old` skips the archive; `--dry-run` shows the plan. The replacement's brief names the pushed head and the pull request: it pushes there, never to a new pull request. On a partial failure, follow the printed state and command.

## Stop and archive

`armada merge` archives the merged worker's workspace once GitHub confirms the merge; never archive before it. For a worker you stop without a merge:

```sh
armada release --ticket ABC-12 --reason "<why it stops>"
armada stop ABC-12
```

`armada stop` refuses while the worker holds the ticket. It checks the exact stored claim, waits up to ten minutes for the final turn to end, cancels it if needed, then archives. Run it also when a merge printed it after a failed cleanup (copy that command whole). The branch and the pull request stay on GitHub.

## Without Armada: manual message

For a worker Armada has no bound launch or claim for (a new login line after a refused token), or a merge note `armada merge` printed because it could not deliver it. Check the current claim, its coordinator and phase first, and send only to the same active worker. If an earlier delivery's outcome was unknown, read the session before sending again.

```sh
printf '%s\n' "<message>" | conductor --json message create --session <sessionId> --message-file -
```

The answer has `messageId` and `state` (`sent` or `queued`). There is no retry deduplication. Never record a printed merge note with `armada answer --note`: that posts it on the ticket.

## Without Armada: status and transcript

```sh
conductor --json session status <sessionId>       # {"status": "working" | "idle" | "error", "updatedAt"}
conductor --json workspace status <workspaceId>   # initializing, ready or archived
conductor --json session message <sessionId> --limit 100 > /tmp/abc-12-events.json
```

Events come oldest first, 100 per page; `.hasMore` says when to fetch the next page with `--after <last event id>`. `.content.rawPayload` is the agent's own format:

```sh
# claude: final replies, then commands
jq -r '.data[] | select(.content.rawPayload.type == "result") | .content.rawPayload.result' /tmp/abc-12-events.json
jq -r '.data[] | select(.content.rawPayload.type == "assistant") | .content.rawPayload.message.content[] | select(.type == "tool_use") | .input.command // .name' /tmp/abc-12-events.json
# codex: messages, then commands with exit codes
jq -r '.data[] | .content.rawPayload.event | select(.type == "item.completed") | .item | select(.type == "agentMessage") | "[\(.phase)] \(.text)"' /tmp/abc-12-events.json
jq -r '.data[] | .content.rawPayload.event | select(.type == "item.completed") | .item | select(.type == "commandExecution") | "exit=\(.exitCode) \(.command)"' /tmp/abc-12-events.json
```

Another agent, or a filter that prints nothing: count the event types (`jq -r '.data[].content.rawPayload | .type // .event.type' … | sort | uniq -c`) and adapt.

## Without Armada: manual stop and archive

Only for a worker Armada holds no claim for:

```sh
conductor --json session cancel <sessionId>
conductor --json workspace archive <workspaceId>
```

Wait until `session status` is `idle` before archiving: a hand-back runs inside the worker's last turn, which still writes its final reply. Poll every 15 seconds; after ten minutes, cancel, then archive.

## Without Armada: manual launch

Only for a deliberate manual launch, with a brief and settings you prepared, and no secrets in `--env`:

```sh
conductor --json workspace create \
  --repo-url https://github.com/<owner>/<name> --branch main \
  --name "ABC-12 <short title>" --session-name ABC-12 \
  --agent claude --model <model-id> --effort high \
  --message-file - < worker-brief.md
```

The answer names `workspaceId`, `sessionId` and `deepLink`. If the launch fails, revoke its token with `armada launch revoke ABC-12`.
