# Coordinator reference

Detail the loop in [SKILL.md](SKILL.md) points to. Read the section you need.

## Named coordinators

A project can share its work between coordinators, each with a name: `ARMADA_COORDINATOR=<name>` in the environment wins, then `armada coordinator use <name>` for this checkout, else `default`.

- Every launch records the coordinator that made it, and the worker inherits that owner from its launch token; a worker cannot choose it.
- `armada status --mine`, `armada inbox --mine` and a named coordinator's `armada watch` show its own workers and unowned items. `armada inbox --all` and `armada watch --all` show the whole fleet (`armada status --all` lists every registered project instead); `default` sees the whole fleet unless it passes `--mine`. Status always keeps the whole frontier and marks another coordinator's pending launch `launching by <name>`.
- Inbox entries name their owner or say `unowned`. Ownership follows the open worker session, then the newest pending launch, then the item. Unowned alarms reach everyone until someone takes them.
- `armada coordinator list` shows each name, its sessions and its tickets. `armada coordinator take ABC-12 --from <name>` moves a ticket's worker (or pending launch) to you atomically; the worker keeps its phase.
- `armada status` names another coordinator's stranded tickets after twice `[policy] silence_minutes` without activity and prints the exact `armada coordinator take … --from <name>` command; take them when resuming that role's work.
- Each name has its own watch lock on a machine: `armada watch --stop` stops yours, `armada watch --stop --name <name>` another's.
- Your own coordination ticket is not a worker: the watch leaves out the claim whose handle is yours (`ARMADA_COORDINATOR_HANDLE`, else Conductor's workspace and session).

## The watch

Plain `armada watch` waits until something you have not been shown needs you (a question, plan, request, hand-back, merge hold, deploy failure, job notice, silent, stopped or unstarted worker), prints it and exits. It exits with `nothing to watch` when nothing in its scope is in flight or open. Armada being down does not end it; a harness time limit can, so start it again when it ends without news. `--for <minutes>` bounds it cleanly.

`armada watch --follow` prints one line per item and keeps running:

- `--for <minutes>` ends it with `resume: armada watch --follow …`; keep it below your harness's command limit.
- A restart resumes this machine's stored cursor for your coordinator name. `--since <cursor>` resumes elsewhere and shows every open item once, marked `open`.
- `--tickets ABC-1,ABC-2` and `--kinds question,hand-back` filter lines. `--kinds claim,report,release,merge,handover` (or `all`) adds informational events; `handover` is a report entering ready-to-merge. `--json` prints NDJSON with a cursor on every line.
- A printed line counts as seen, even if your harness never read it: use follow only where every line reaches you. Harnesses that wake only when a command ends keep plain watch.

Both modes share one lock per project and name on a machine. `armada inbox --wait [--timeout <seconds>]` (300 by default) is the fallback for a runtime that cannot run a background command.

## Silence and liveness

- **Silent**: no heartbeat, report or answer for `[policy] silence_minutes` (15 by default). A worker's first allowance adds `launch_grace_minutes` (defaults to `silence_minutes`). Shipping at stage `ci` gets `ci_wait_minutes` (45 by default). Waiting phases (`awaiting-approval`, `blocked`, `awaiting-validation`) are never silent while unanswered.
- **Conductor sessions are observed**: a session Armada sees working is only called silent past twice the allowance, and the alert says it is still working. A session idle in a working phase for five minutes without a report or answer is `stopped`: nothing will wake it.
- A silence wakes the watch at its allowance, then at twice, four times and each doubling after.
- **Quiet**: a live worker without a report for `quiet_minutes` (45 by default) is a note for you only.
- **Not started**: no claim `not_started_minutes` (10 by default) after the launch. An unused token that expired produces one notice, then clears.
- Claims end by themselves when their ticket is Done or Canceled, their hand-back merged, their session was revoked or their workspace archived.

## Upgrades

`armada status` and `armada inbox` mention a new Armada release at most once a day; ordinary releases leave the watch running. A `version` item stops both watch modes: the server needs a newer CLI, or this project's installed skills are behind. Run `armada upgrade`: it waits for npm, installs the release, checks `armada --version`, and runs `armada init --merge` only when the project's setup is outdated. Workers in flight keep the version their brief pinned.

## Specs

Specs are direct children of the program root, titled `Spec N — Name` (`Spec N/M — Name` is read too).

- `armada spec add "<name>"` appends one with the **In short** template and prints its URL; earlier titles are untouched.
- `armada spec add "<name>" --at 5` previews the renames a middle insertion needs; repeat with `--apply` to write them.
- `armada spec renumber` previews a repair of gaps, duplicates and stale totals; `--apply` writes it.
- `[tracker] spec_titles = "N/M"` keeps totals in every title; appending then needs `--apply` too.
- Writes are sequential and stop at the first failure, listing what was not confirmed: inspect Linear before retrying.

When `armada merge` closes a spec's last open ticket, it closes the spec with a summary, unless the team's own parent auto-close does it.

## Secrets

The secrets workers need (an LLM key, a test database URL) are kept per project in Armada, and workers use them through `armada run -- <command>`.

- `armada secrets` lists the names, never a value. `armada doctor` names those `[secrets] names` expects and Armada lacks.
- An owner or admin sets one with `armada secrets set <NAME>` (hidden prompt), `--value-stdin`, or `--from-env <VAR>`, which moves a variable without anyone reading it; `--org` sets it for every project. `armada secrets unset <NAME>` removes it.
- Anyone else asks with `armada secrets request <NAME> --ticket <id> --reason "<why>"`: the owner gets a link and types the value into the vault. Repeated requests reuse one link.
- Never put a value on a command line, in a brief, in notes or in chat. A value pasted anywhere must be rotated.

## Long jobs

Long runs (an evaluation, a backfill, a load test) run on the project's own runner, declared in `[jobs.<name>]` with its start, status and stop commands. Never run them in a session.

- `armada job start <name> --ticket <id>` dispatches one and stores its runner reference; `armada job status` asks the runner, `armada job list` reads stored progress.
- `armada job stop <id>` stops one on purpose; nothing is stopped automatically, even when its ticket is Done.
- A runner can push progress with `armada job beat <id> --progress "40/120"`, signed in with an organization API key.
- A job without news past its silence limit is a `job-silent` entry; a finished job leaves one `job` notice. Read it, then `armada answer <item> "<what you checked>"`.
- `armada job recover <id> --ref <reference>` attaches a runner reference that a lost answer did not record.

## Shared resources

Migration numbers, ports and other shared names are reserved per ticket through Armada: `armada reserve <key> --next --floor <n>` for numbers, `--value <name>` for names. `armada reserve --list` shows the holders. A release frees a ticket's reservations; a merge keeps them used for good. Declare well-known keys in `[[reservations]]` so briefs list them.

## The owner's channel

Organization > Notifications (owner or admin) connects one chat webhook. Owner validations, escalated questions and a stopped coordinator with items waiting reach it by themselves, outside quiet hours. Digests go out at the times set there; `armada digest --send` posts one now, and `armada digest --lang en|fr` overrides `[tracker] language` for the printed text.
