---
name: armada-runtime-conductor
description: Runtime guide for running Armada workers on Conductor Cloud. Use when an Armada coordinator must launch a worker on a ticket, send it a message, check whether a silent worker is still alive, or stop and archive it. Four fixed sections, each with the exact conductor command and how to read its output.
---

Herdr and Conductor workers use Armada’s integrated runtime interface; Claude Code subagents use their guide. `armada status` and `armada inbox` publish Conductor’s live state, and `armada stop` archives it after release or merge. Native launch is `armada launch`; message delivery below remains the guide path until its integrated command ships. This guide tells the coordinator how to launch, message, check and stop a worker with the `conductor` command line tool, and what to record in Armada afterwards. It was checked against `conductor` 0.89.x (the desktop app's CLI, macOS) and 0.1.x (the CLI inside a Conductor Cloud workspace, Linux); every command below works in both. `conductor --version` prints yours; if a flag is refused, compare with `conductor <command> --help`.

- On a Mac, the app ships the CLI at `/Applications/Conductor.app/Contents/Resources/bin/conductor`, which is not on PATH. `armada doctor` looks for it and prints the fix: a link from a directory already on PATH (`ln -s "/Applications/Conductor.app/Contents/Resources/bin/conductor" ~/.local/bin/conductor`), or a PATH line for your shell profile.
- Always pass `--json` and read fields with `jq`. Exit codes: 0 ok, 1 runtime error, 2 usage error, 3 authentication, 4 server error.
- On exit code 3, `conductor auth whoami` checks the token the CLI uses (it exits 0 when the token works). Do not rely on `conductor auth status`: it only looks for a macOS Keychain entry and fails on Linux ("Keychain storage is only supported on macOS"). In a Conductor Cloud workspace the CLI reads `CONDUCTOR_API_KEY` from the environment and needs no login; on a Mac, `conductor auth login` stores a token in the Keychain.
- A worker is one workspace with one session. Its Armada handle is `<workspaceId>/<sessionId>`; the worker's claim comment carries it, so `armada status` and the ticket always lead back to the session.
- A worker needs no key in its workspace: the prompt of `armada brief` carries a one-time launch token, and the worker's first command exchanges it for a session limited to its ticket, through which Armada gives each command its keys. The token works once, within the hour, so a copy left in a transcript is useless once used.
- Native launch requires an Armada sign-in (`armada login`). Armada passes the brief through stdin and never prints its token; do not pass keys through Conductor’s `--env`.

## Launch

The brief starts `armada heartbeat --every 5m --parent "$PPID" --background` immediately after claim. It creates a detached process group (like `nohup` + `setsid`) with closed terminal streams and a PID file under `~/.config/armada/watch/`. Plain `&` and `nohup` alone can be killed by command-tool cleanup on Cloud. Detachment does not extend the monitored agent's lifetime: `$PPID` in the agent's command shell is the agent process, never `$$` (the shell), and a runtime may replace that process between turns. The heartbeat stops with that parent or when Armada ends the current session (release, merge, revoke).

Workers in `awaiting-approval`, `blocked` or `awaiting-validation` end their turn and need no heartbeat or manual report while the decision is pending. After delivering and recording an answer, let the worker resume: it reports its working phase and runs the brief's heartbeat line again with the current `$PPID`. An existing heartbeat for the same claim is kept. Armada counts silence from the newest heartbeat, report or answer, so a heartbeat left over from a previous turn cannot make a newly resumed worker immediately silent. An answered worker that never resumes still becomes silent after `policy.silence_minutes`. If startup fails or the runtime cannot retain any background process, fall back to manual reports at least every 15 minutes during active work and record that fallback on the ticket. Reports remain meaningful progress updates; `policy.quiet_minutes` counts time without a report while heartbeats arrive.

1. Pick a ready ticket from `armada status` that does not collide with work in flight.
2. Read the ticket and parent, then choose its profile. A matching label rule wins; otherwise match the profiles' `when` rules by most files/work. Mixed front-end/back-end work: choose the larger part and say why with `--profile <name> --reason "<why>"`. An optional `armada brief ABC-12` or `--json` preview helps resolve the choice and warnings, but is read-only: neither creates a launch token nor marks a worker in flight. If the choice is still needed, `--prompt` refuses before minting anything.
3. Launch with one command, keeping the selected profile and its reason:

```sh
armada launch ABC-12 --runtime conductor --profile <name> --reason "<why>" --notes notes.md
```

`--profile`, `--reason` and `--notes` are optional when routing settles the profile and there is no extra context. `--notes -` reads stdin. A notes path is relative to the command’s current folder; the file must exist, be nonempty and fit within 16 KB. Notes add context only: the brief’s Plan line still decides whether the worker waits. Put conventions every worker needs in `[brief] extra` instead.

Use `--dry-run` to inspect settings and preflight without creating a token or workspace. Native launch checks the ticket, pending launches, the profile and Conductor sign-in, then takes a launch lease before minting the token. It creates one workspace with the profile’s explicit agent, model, effort and fast mode. `[conductor] project_id` selects a Conductor project instead of the configured repository URL; `base_branch` overrides origin’s default branch. Conductor creates its own branch; the brief tells the worker to rename it to Linear’s suggested branch.

4. Keep the printed workspace/session handle and session link. Known launch failures revoke that exact token. A lost answer or create runtime error is recovered through a bounded repository/time search without repeating create; workspace and session names may have changed. Only a unique candidate still bearing the requested workspace and session names is adopted automatically. Renamed, ambiguous or incomplete results retain the pending launch and name visible candidate ids and recovery commands. An unavailable or malformed recovery search also retains the pending launch; only a completed search with no candidate cancels it automatically. Never run a second launch before checking the first. A warning about session binding leaves the launched worker running: its first sign-in records the same handle.

5. **Check the claim.** Within a few minutes, `armada status` lists the ticket in flight, phase `planning`, runtime `Conductor`, and the ticket's claim comment reads `session: <workspaceId>/<sessionId>` and `profile: <name>`. No claim after `[policy] not_started_minutes` (ten by default): `armada watch` and `armada inbox` show a `not-started` entry; status lists it under "Pending launches" with `armada launch revoke ABC-12`. It says whether the worker never used its launch token (it never reached its login line) or signed in and stopped before its claim. An unused token expired more than an hour ago produces one `not started (token expired)` inbox notice, then clears. Exchanged launches without a claim stop being followed after 24 hours and remain revocable. Read the transcript (Status section). A worker whose launch token was refused (already used, or more than an hour old) needs a new one: `armada brief ABC-12 --prompt --profile-line` again, and message it only the `armada login --launch-token …` line of the new `--prompt` output (Message section). A worker cut off from Armada was revoked (Organization > Workers says by whom) or left idle for three days: ask the owner before you give a revoked worker a new token. If the worker cannot claim for another reason, fix the cause and message it; as a last resort record the handle yourself with `armada claim ABC-12 --runtime conductor --handle <workspaceId>/<sessionId> --profile <name>`, adding the brief's `--reason` for an override.

## Message

```sh
printf '%s\n' "Plan approved. Go on." | conductor --json message create --session <sessionId> --message-file -
conductor --json message create --session <sessionId> --message-file - < /tmp/abc-12-answer.md
```

The output is `{"messageId": …, "state": "sent"}`. Exit code 0 means Conductor accepted the message, not that the worker read it: check that the session turns `working`, then read its reply in the transcript. Use it to deliver an answer, a plan approval, or a heads-up that the default branch moved. Then record it in Armada: `armada answer <item> "<answer>"` for a question from `armada inbox`, `armada answer --note ABC-12 "<message>"` for a message the worker did not ask for.

## Status

```sh
conductor --json session status <sessionId>
```

The output is `{"workspaceId", "sessionId", "status", "updatedAt"}`. For a worker:

- `working`: a turn is running. A silent worker that is `working` is busy (a long build or test run): leave it, and read the transcript if it stays silent past twice `policy.silence_minutes`.
- `idle`: no turn is running. The worker finished its turn: it handed back, it waits for an answer, or it stopped without finishing. If `armada status` does not show it `ready-to-merge`, `awaiting-approval`, `awaiting-validation` or `blocked`, it has stopped: read its last reply, then message it to go on, or release and relaunch the ticket.
- `error`: the last turn failed (agent or provider failure). Read the transcript and message it to resume; if it fails again, cancel, archive, release and relaunch.
- Right after launch the session is `idle` for a few seconds while the workspace is initializing and the first message is queued; it turns `working` when the agent starts.

The workspace itself: `conductor --json workspace status <workspaceId>` gives `status` `initializing`, `ready` or `archived`.

**Read the transcript** to see what a worker did or said. Events come oldest first, 100 per page; `hasMore` tells when to fetch the next page with `--after` the last event id. Keep the last id you read and poll from it.

```sh
conductor --json session message <sessionId> --limit 100 > /tmp/abc-12-events.json
jq -r '.hasMore, .data[-1].id' /tmp/abc-12-events.json
conductor --json session message <sessionId> --after <lastEventId> --limit 100
```

The second line prints whether more pages exist and the id to continue from. `.content.rawPayload` is the agent's own event format, so the filters depend on the worker's agent (the `agent` of its profile in `armada.toml`).

A `claude` worker: each turn's final reply, then the commands and tools it ran.

```sh
jq -r '.data[] | select(.content.rawPayload.type == "result") | .content.rawPayload | "error=\(.is_error)\n\(.result)"' /tmp/abc-12-events.json
jq -r '.data[] | select(.content.rawPayload.type == "assistant") | .content.rawPayload.message.content[] | select(.type == "tool_use") | .input.command // .name' /tmp/abc-12-events.json
```

A `codex` worker: its events are `.content.rawPayload.event`, each item once as `item.started` and once as `item.completed`; read the completed ones. Its messages (`phase` is `commentary` along the way, `final_answer` at the end of a turn), then each command with its exit code, and its tool calls (Linear and other MCP servers).

```sh
jq -r '.data[] | .content.rawPayload.event | select(.type == "item.completed") | .item | select(.type == "agentMessage") | "[\(.phase)] \(.text)"' /tmp/abc-12-events.json
jq -r '.data[] | .content.rawPayload.event | select(.type == "item.completed") | .item | select(.type == "commandExecution") | "exit=\(.exitCode) \(.command)"' /tmp/abc-12-events.json
jq -r '.data[] | .content.rawPayload.event | select(.type == "item.completed") | .item | select(.type == "mcpToolCall") | "\(.server) \(.tool)"' /tmp/abc-12-events.json
```

Another agent, or a filter that prints nothing: count the event types, look at one event of the type you need, and adapt the filter.

```sh
jq -r '.data[].content.rawPayload | .type // .event.type // "(no payload)"' /tmp/abc-12-events.json | sort | uniq -c
```

## Stop and archive

```sh
armada stop ABC-12
```

`armada merge` archives the workspace automatically after GitHub confirms the merge; never archive before it prints "Merged". `--no-archive` retains it. Run `armada stop` only to finish a failed cleanup (the merge prints that command), or after `armada release --ticket ABC-12 --reason "<why>"`. Armada refuses while the worker still holds the ticket. It checks the exact stored claim and session’s workspace, waits for the final turn to finish (polling every 15 seconds for up to ten minutes), then cancels if needed and archives. A replaced claim is refused before any runtime write; an already archived workspace is safe to record again.

## Without Armada: manual stop and archive

Only use this appendix when Armada does not hold the worker’s claim. For registered workers, use `armada stop` so its generation guard protects replacement sessions.

```sh
conductor --json session cancel <sessionId>
conductor --json workspace archive <workspaceId>
```

- `session cancel` stops the running turn: `{"status", "canceledQueuedMessages"}`, and the session is `idle` within seconds. The workspace stays; a message starts a new turn. Use it on a worker that runs the wrong thing.
- `workspace archive` answers `{"status": "archived"}`. Archive a worker's workspace after its pull request is merged, or after `armada release --ticket ABC-12 --reason "<why>"` for a worker that stops without handing back. The branch and the pull request stay on GitHub.
- **Wait for `idle` before archiving.** A hand-back often arrives while the worker's session is still `working`: `armada report ready-to-merge` runs inside its last turn, which then writes its final reply. Archive only once `session status` answers `idle`. Poll it every 15 seconds; if it is still `working` after 10 minutes, cancel the turn and archive (the transcript keeps what it was doing). Run the whole block as one command; it can take up to 10 minutes, so run it in the background or give it a longer command timeout:

```sh
for i in $(seq 40); do
  [ "$(conductor --json session status <sessionId> | jq -r .status)" = working ] || break
  sleep 15
done
[ "$(conductor --json session status <sessionId> | jq -r .status)" = working ] && conductor --json session cancel <sessionId>
conductor --json workspace archive <workspaceId>
```
- After an archive, `session status` still answers `idle`; `workspace status` says `archived`.

## Without native Armada launch: manual Conductor creation

Use this only for a deliberately manual launch. Prepare a worker brief and explicit settings yourself; do not pass secret environment variables. For Armada-managed workers, use `armada launch` so preflight, pending-launch protection, token cancellation and recovery are automatic.

```sh
conductor --json workspace create \
  --repo-url https://github.com/<owner>/<name> --branch main \
  --name "ABC-12 <short title>" --session-name ABC-12 \
  --agent claude --model <model-id> --effort high \
  --message-file - --env ARMADA_TICKET=ABC-12 < worker-brief.md
```

The answer names `workspaceId`, `sessionId`, `deepLink` and the initial-message acknowledgement. Check these and the worker’s claim; a manually minted Armada token must be revoked with `armada launch revoke ABC-12` when the launch fails.
