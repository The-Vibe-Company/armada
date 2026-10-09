# Coordinator reference

Detail the loop in [SKILL.md](SKILL.md) points to. Read the section you need.

## Coordinator guardrails

- Never block the session with a foreground command for more than a minute. Run `armada merge <pr> --wait` in the background, or queue with `armada merge --when-green <pr...>` and run `armada merge --drain` in the background. Keep `armada watch` in the background while these run. A declared long job uses `armada job start <name> --ticket <id>` on its runner.
- Write no ticket code yourself. A fix of any size needs a ticket and a worker: cut a ticket and launch a worker. Changes to `armada.toml` that Armada asks for also go through a worker pull request merged with `armada merge`.
- Run Armada commands bare. Never pipe them into `grep`, `tail` or `head`, redirect them to `/dev/null`, wrap `2>&1 | …`, or append `|| true`: their last lines say whether it worked and what to do next. A wrapper once hid a failed urgent launch for 2 hours 35 minutes.
- Merge through `armada merge`. When it cannot run, follow [By hand](MERGE.md#by-hand), then `armada merge --finish <n>` and the deploy check for every declared target.
- When the owner asks where things stand, run `armada digest` and paste its text.

## Named coordinators

A project can share its work between coordinators, each with a name: `ARMADA_COORDINATOR=<name>` in the environment wins, then `armada coordinator use <name>` for this checkout, else `default`.

- Every launch records the coordinator that made it, and the worker inherits that owner from its launch token; a worker cannot choose it.
- `armada status --mine`, `armada inbox --mine` and a named coordinator's `armada watch` show its own workers and unowned items. `armada inbox --all` and `armada watch --all` show the whole fleet (`armada status --all` lists every registered project instead); `default` sees the whole fleet unless it passes `--mine`. Status always keeps the whole frontier and marks another coordinator's pending launch `launching by <name>`.
- Inbox entries name their owner or say `unowned`. Ownership follows the open worker session, then the newest pending launch, then the item. Unowned alarms reach everyone until someone takes them.
- `armada coordinator list` shows each name, its sessions and its tickets. `armada coordinator take ABC-12 --from <name>` moves a ticket's worker (or pending launch) to you atomically; the worker keeps its phase.
- `armada status` names another coordinator's stranded tickets after twice `[policy] silence_minutes` without activity and prints the exact `armada coordinator take … --from <name>` command; take them when resuming that role's work.
- Each name has its own watch lock on a machine: `armada watch --stop` stops yours, `armada watch --stop --name <name>` another's.
- Your own coordination ticket is not a worker: the watch leaves out the claim whose handle is yours (`ARMADA_COORDINATOR_HANDLE`, else Conductor's workspace and session).

## The Claude Code stop hook

The hook matches the `session_id` of a coordinator that ran `inbox`, `watch`, `brief`, `launch` or `merge`, across working folders. Unknown sessions fall back to the checkout where the coordinator last watched. A session coordinating several projects is held if any of them needs a watch; the reason names each project and checkout. Worker sessions (`ARMADA_TICKET`) never register or get held. A resumed session with a new id registers on its next coordinator command.

The watch's start and end, the last lines of coordinator commands, and `armada doctor` show `Stop hook on for this session (last ran HH:MM)`, `Stop hook installed in <file>; it confirms at your next turn end`, or `Stop hook NOT on: <why> — <fix>`. Installation alone is not proof that Claude loaded it: the next Stop records a local receipt. All hook reads are local and failures let the turn end.

At Stop, the hook also reads up to 1 MiB of new transcript lines for this coordinator session. A completed foreground Bash command over 60 seconds, raw `gh pr merge`, wrapped Armada output, or `git commit`/`gh pr create` produces one reminder per rule per session, with a safe program/subcommand summary (arguments omitted) and the replacement to run. Quoted examples, comments and heredoc data are ignored. A multi-project session reads its transcript once and uses the current checkout’s deploy config; outside known checkouts, each known target command names its config explicitly. The reminder joins the watch reason in one blocked Stop; later turns do not repeat that rule, even after compaction. A reentrant Stop skips habit reminders and keeps the watch guard. Workers, subagents and unknown sessions in other checkouts are excluded; `ARMADA_STOP_HOOK=off` disables these reminders too.

Armada detects the command in user settings (`~/.claude/settings.json`) and the coordinator checkout's `.claude/settings.json` or `.claude/settings.local.json`. If the session starts elsewhere, add a command hook for Stop in user settings: `armada hook stop 2>/dev/null || true`. `armada init --merge` changes repository settings only. `ARMADA_STOP_HOOK=off` opts out; the banner says so.

## The SessionStart brief

`armada init` and `--merge` install both Stop and SessionStart in repository settings, once; one question accepts both, and `--no-stop-hook` skips both. `armada doctor` warns when SessionStart is missing. SessionStart matches `compact|resume` only; fresh startup still follows [Start](#start).

After compact or resume, `armada hook session-start` inserts plain text into Claude's context: `Armada: you coordinate <project> as <name> from <checkout>`, tickets with phases and ages, PRs and holds, up to 20 actionable inbox lines, and the watch and Stop-hook banners. The block is at most 60 lines. Run every Armada command from the named checkout; read `armada status --mine` and `armada inbox --mine` before acting. Its final line tells you to start `armada watch` with Bash `run_in_background` when none runs. The hook never starts a watch itself. A live read records presence and only the inbox keys actually shown; omitted items can still wake the watch.

Live reads share a 15-second deadline and are aborted on expiry. If unavailable or refused, the brief uses the last local tickets, read time and open jobs, and names the status/inbox recovery commands. All hook errors allow the session to start. Workers (`ARMADA_TICKET`) get nothing.

Resolution uses the Stop hook's registry first, then the coordinator checkout for unknown ids. A resumed session with a new id outside that checkout gets nothing. To deliver hooks for sessions starting elsewhere, install both commands at user level in `~/.claude/settings.json`: Stop runs `armada hook stop 2>/dev/null || true` (timeout 10); SessionStart runs `armada hook session-start 2>/dev/null || true` with matcher `compact|resume` (timeout 30). Init only changes repository settings.

## The watch

Plain `armada watch` waits until a new own or unowned item you have not been shown needs you (a question, plan, request, hand-back, merge hold, deploy failure, job notice, silent, stopped or unstarted worker), prints it and exits. Items owned by another named coordinator stay in the listing, marked `owner: <name>`, but do not wake you, even with `--all`. Reading `armada inbox` preserves shown history; `--mine` cannot prune keys from a broader `--all` read. It exits with `nothing to watch` when nothing in its scope is in flight or open. Armada being down does not end it. A timeout prints the resume command and re-arm line on stdout; start it again when it ends without news. `--for <minutes>` bounds it cleanly.

Starting another plain watch is safe: it waits locally for the verified holder, then prints the holder's stdout/stderr and exit code here. A JSON waiter behind a plain holder wraps the result and captured streams in JSON; stop results stay JSON too. The private result file keeps the most recent 100 generations so a fast later holder does not erase the awaited receipt. If the holder dies without a result, a waiter takes over. `armada watch --stop` ends the holder and its waiters. A follow holder remains a stream: another watch only says it is following. Keep the watch in your harness's tracked background command; never put `&` inside a foreground command or hide its output.

Under Claude Code (`CLAUDECODE` set), either watch defaults to 100 minutes, leaving margin before the two-hour background limit. It prints the bound at start and in its final output. If a dead watch left an identity-bearing lock without a completion result and its observed lifetime was between five minutes and the current bound, Armada remembers that shorter limit and ends the next watch after 90% of it (rounded down, minimum five minutes). New locks keep a wall-clock watch start alongside the OS process identity; older timestamp identities can also teach a limit, while legacy PID-only locks cannot. `--for <minutes>` overrides the automatic bound.

`armada watch --follow` prints one line per item and keeps running:

- `--for <minutes>` ends it with `resume: armada watch --follow …`; the Claude Code automatic bound applies unless you set it.
- A restart resumes this machine's stored cursor for your coordinator name. `--since <cursor>` resumes elsewhere and shows every open item once, marked `open`.
- `--tickets ABC-1,ABC-2` and `--kinds question,hand-back` filter lines. `--kinds claim,report,release,merge,handover` (or `all`) adds informational events; `handover` is a report entering ready-to-merge. `--json` prints NDJSON with a cursor on every line.
- A printed line counts as seen, even if your harness never read it: use follow only where every line reaches you. Harnesses that wake only when a command ends keep plain watch.

Both modes share one lock per project and name on a machine. `armada inbox --wait [--timeout <seconds>]` (300 by default) is the fallback for a runtime that cannot run a background command.

Plain watch also reminds about open questions, plans, unqueued hand-backs, owner requests and decisions, runtime approval prompts, queue refusals, and unstarted or stopped workers. `[policy] coordinator_minutes` sets the first interval (10 by default); subsequent intervals double. Reminders are anchored to the first show: at 10, 30 and 70 minutes by default, even if you list the inbox between them. The output marks `! still waiting since HH:MM UTC`. `coordinator_minutes = 0` disables reminders. Other coordinators' items and queued hand-backs never remind. Losing the machine watch state restarts the clock at the next listing; follow mode retains its once-per-key stream.

`armada ack <#id or key> --reason "<why>"` records a deliberate skip of a notice, with its reason on the ticket. It hides that entry until its key changes. A higher silence level or another merged blocker is a new key. The command refuses questions, plans, hand-backs, owner requests, approval prompts and holds, and names the action that resolves them. A ticketless notice stays recorded in Armada only; if its Linear comment fails, post the printed text yourself. Deploy the API and its migration before the new CLI.

Eligible notices are `queue-refused`, `deploy`, `job`, `unblocked`, `silent`, `quiet`, `stopped`, `not-started`, `job-silent` and `queue-stalled`. Derived entries print `key <entry key>` on their head line. The ticket note preserves the worker's phase. Comment creation is attempted once; never retry it blindly after a failure.

## Kept deliveries

An unconfirmed Conductor answer, note or merge notice stays in Armada. The command exits 1 without posting an answer on Linear or closing its question. Keep `armada watch` running: plain and follow modes retry at most three due deliveries per poll, with the same message id and stored masked text. The delays are 1, 2, 5, 10 and 20 minutes, with six tries including the first send. Rerunning the same answer command reuses that delivery; edited text creates another, and confirming it retires the older pending answer for that item.

Before each send Armada checks the worker generation and ownership. Merge notices also skip sessions that handed back. A changed or released worker, a permanent refusal or six unconfirmed tries produces one `delivery-failed` inbox item naming the ticket and the first line of the message. Inspect the session, decide the next step, then `armada answer <failure item> "<why>"` records your reason without sending it. A later successful answer for the ticket also resolves its failure item. Never send a kept message by hand too.

Confirmed delivery is terminal before Linear and inbox recording. A recording warning asks you to inspect the ticket; Armada never sends that confirmed message again. Pending deliveries appear in status and inbox and keep the stop hook listening. Without a watch they wait. Herdr and Claude Code have no keyed delivery and stay on their runtime guide's inspect-first path. Deploy the pending-delivery API and migration before this CLI.

## Worker caps

`[policy] max_workers` caps project-wide worker sessions, including open claims waiting for merge and unclaimed launches. A full fleet refuses a new launch: use `armada launch <ticket> --when-unblocked` to wait for a slot, or `armada launch <ticket> --over-cap "<why>"` for a recorded bypass. Never use relaunch to bypass the cap; it replaces an existing worker. Urgent tickets pass automatically with a recorded reason. Status and re-arm lines show running workers separately from launches waiting for a slot. Without this setting, launches are uncapped; lowering it stops no worker.

## Silence and liveness

- **Silent**: no heartbeat, report or answer for `[policy] silence_minutes` (15 by default). A worker's first allowance adds `launch_grace_minutes` (defaults to `silence_minutes`). Shipping at stage `ci` gets `ci_wait_minutes` (45 by default). Waiting phases (`awaiting-approval`, `blocked`, `awaiting-validation`) are never silent while unanswered.
- **Conductor sessions are observed**: a session Armada sees working is only called silent past twice the allowance, and the alert says it is still working. A session idle in a working phase for five minutes without a report or answer is `stopped`: nothing will wake it.
- A silence wakes the watch at its allowance, then at twice, four times and each doubling after.
- **Quiet**: a live worker without a report for `quiet_minutes` (45 by default) is a note for you only.
- **Launch failed or uncertain**: `launch-failed` and `launch-uncertain` are recorded immediately for an attempted runtime launch, including deferred launches during merge/drain. The watch wakes on them. Read the reason and run the item’s `Next:` command. Failed launches and recovered but unconfirmed launches exit 1; preflight refusals still exit 2. An uncertain launch retains its token: inspect the worker before retrying creation. The `Launched` line and dry-run plan include the ticket title; JSON includes `title`. Repeated failures rewrite the same open item. It closes on the next claim, a successful launch binding, `armada launch revoke <ticket>`, or `armada answer <id> "<why>"`. Recording on Armada is best-effort; a recording warning never turns failure into success.
- **Not started**: no claim `not_started_minutes` (10 by default) after the launch. An unused token that expired produces one notice, then clears. An open `launch-failed` or `launch-uncertain` item suppresses this notice for its ticket.
- Claims end by themselves when their ticket is Done or Canceled, their hand-back merged, their session was revoked or their workspace archived.

## Upgrades

`armada status` and `armada inbox` mention a new Armada release at most once a day; ordinary releases leave the watch running. Only a CLI below the server minimum stops either watch mode with a `version` item, worded `Armada <x> required (you run <y>)`. Setup behind gets a separate daily notice in status, inbox and plain watch's final output: “This project's Armada setup is behind <version>: `armada upgrade`, then merge the setup pull request it opens.” Setup drift leaves the watch running. Run `armada upgrade`: it waits for npm, installs the release, checks `armada --version`, and runs `armada init --merge` only when the project's setup is outdated. Workers in flight keep the version their brief pinned.

## Specs

Specs are direct children of the program root, titled `Spec N — Name` (`Spec N/M — Name` is read too).

- `armada spec add "<name>"` appends one with the **In short** template in the root's Linear project and the team's first backlog state (first to-do state if there is no backlog); it prints the project (or `no project`), state and URL. With neither state available, it keeps Linear's default. Earlier titles are untouched. Creation is never retried automatically: check Linear before running the command again after a failure.
- `armada spec add "<name>" --at 5` previews the renames a middle insertion needs; repeat with `--apply` to write them.
- `armada spec renumber` previews a repair of gaps, duplicates and stale totals; `--apply` writes it.
- `[tracker] spec_titles = "N/M"` keeps totals in every title; appending then needs `--apply` too.
- Writes are sequential and stop at the first failure, listing what was not confirmed: inspect Linear before retrying.

Check the printed project and state after creation. Fill in the **In short** template before cutting the spec's tickets, then run `armada lint <ticket>` on each one.

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
- A running job with progress unchanged past `[jobs.<name>] stall_minutes` (60 by default) shows `stalled` and a `job-stalled` inbox alert. Check it with `armada job status <id>`; use `armada job stop <id>` only when you intend to stop it. Fraction progress (`n/m`) ignores ETA/clock changes; movement clears the alert and a later stall wakes the watch again. Silent jobs take precedence, and jobs without progress are never stalled. This only covers runs tracked through `armada job`; the alert never stops the job.
- A job without news past its silence limit is a `job-silent` entry; a finished job leaves one `job` notice. Check it, or deliberately leave the notice alone with `armada ack <#id or key> --reason "<why>"`.
- `armada job recover <id> --ref <reference>` attaches a runner reference that a lost answer did not record.

## Shared resources

Migration numbers, ports and other shared names are reserved per ticket through Armada: `armada reserve <key> --next --floor <n>` for numbers, `--value <name>` for names. `armada reserve --list` shows the holders. A release frees a ticket's reservations; a merge keeps them used for good. Declare well-known keys in `[[reservations]]` so briefs list them.

## The owner's channel

Organization > Notifications (owner or admin) connects one chat webhook. Owner validations, escalated questions and a stopped coordinator with items waiting reach it by themselves, outside quiet hours. Each named coordinator is checked separately, including owner requests and project-wide operational items. A coordinator that keeps running commands also triggers one alert per unanswered plan, question, hand-back, decision or owner request after 3 × `[policy] coordinator_minutes` (30 minutes by default); queued or paused merges are excluded. Finished specs send their Linear link once after the next reading. A merge pause still open after five minutes sends its reason and project link; clearing a recorded pause sends “merges resume”. Short pauses and pre-channel history stay quiet. These milestones are channel-only, follow the alerts toggle, and are retained during quiet hours for the next summary. Act on the inbox rather than relying on command activity to keep these alerts quiet. GitHub and Linear webhook refreshes check alerts even with no live worker or viewer. Digests go out at the times set there; `armada digest --send` posts one now, and `armada digest --lang en|fr` overrides `[tracker] language` for the printed text.

## Waiting launches

`armada launch <ticket> --when-unblocked [--profile <name>] [--runtime conductor|herdr] [--notes <file|->]` remembers a launch until its Linear blockers close or a worker slot frees. `--after <blocker>` asserts an existing Linear relation. Without `--profile`, routing uses the ticket's labels when it starts; an explicit profile stays pinned, with its reason. Runtime and notes text survive until launch; explicit options when firing override the stored values.

Requests expire after seven days. The inbox shows one expiry notice with the renew/decline commands. Repeat `armada launch <ticket> --when-unblocked` to renew the same request for seven more days and reset its attempt budget; omitted options preserve its pin and context. Decline with `armada answer <id> "<why>"`. Completed or cancelled tickets close their request automatically. A launched worker waiting to claim is shown quietly in status.

The running watch starts eligible requests itself, oldest first, at most one per poll, when any blocker closes or a worker slot frees. Successful starts stay quiet in plain watch and appear in status and the next re-arm line; follow prints a `launched` line, respecting `--tickets` and `--kinds` (use `--kinds launched` for starts alone). Merge/drain still fire the tickets that their merge unblocked. Only this coordinator's requests fire, with no cap bypass. Herdr starts on the watch's machine; automatic launches never prompt to install tools.

Fire-time admission checks cancellation, expiry and ownership; launch rechecks the request after preflight and fresh Linear readiness, including the ready label. Known failures, including missing runtime tools, arrive as one rewritten `launch-failed` inbox item. Keep/re-arm watch to retry after five minutes, then fifteen minutes, at most three attempts total. The third failure says `gave up after 3 failed launches`; renew or decline deliberately. An uncertain creation keeps its pending launch even after token expiry: inspect and revoke it before another automatic creation. Guided Claude Code profiles stay manual inbox work with `armada brief ... --prompt` for the Agent tool. `coordinator take` transfers the waiting request too. Missing readings or unavailable admission/attempt metadata prevent automatic firing: deploy the dashboard before the CLI.

## Start

After Claude compact/resume, follow the Armada brief; see [REFERENCE.md](REFERENCE.md#the-sessionstart-brief).

1. **Sign in.** `armada whoami` says whether this terminal is signed in and to which organization. If not: a person runs `armada login` and approves the code in the browser; a headless coordinator (a cloud workspace, CI) sets `ARMADA_API_KEY` to an organization API key an owner created, or runs `armada login --api-key`. Signed in, Armada gives each command the organization's keys and puts a one-time launch token in every brief, so no worker needs a key. Keys set in the environment still win. `armada doctor` checks the repository and the sign-in together.
2. **Take your name.** One project can have several coordinators, each with a name. Set `ARMADA_COORDINATOR=<name>` (a cloud workspace) or run `armada coordinator use <name>` (this checkout); without either the name is `default`. A named coordinator sees its own workers and unowned items; `default` sees the whole fleet. `armada coordinator list` shows the names, their sessions and tickets. Status names work stranded under a silent role with the `armada coordinator take … --from <name>` command; use it when you resume that work. See REFERENCE.md before sharing a project.
3. **Find your coordination ticket**, if the owner gave you one. Read its comments, newest first. A last comment `Agent status: released — <text>` is a hand-over: `<text>` is the state the previous coordinator left. Claim the ticket with your own handle, never the previous one: `armada claim <ticket> --runtime <your runtime> --handle <your handle> --branch <default branch>` (in Conductor, `--runtime conductor --handle "$CONDUCTOR_WORKSPACE_ID/$CONDUCTOR_SESSION_ID"`; elsewhere set `ARMADA_COORDINATOR_HANDLE` to the handle you claimed with). Report on it as a worker would, `armada report implementing --ticket <ticket> --message "<what you found and do next>"`, and hand over with `armada release --ticket <ticket> --reason "<state so far and what remains>"` when you stop before the run ends. Write that reason for a reader with none of your context.
4. **Run from anywhere.** Commands find the project from the checkout. From another folder, pass `--project <slug>` (this machine's last watched checkout) or set `ARMADA_CONFIG=/path/to/armada.toml`; `--config <path>` wins over both.

## Launch details

6. **Launch** Conductor and herdr workers with one command:

```sh
armada launch ABC-12 --runtime conductor --profile backend --pre-approve --reason "CLI and core only; a small follow-up" --notes notes.md
```

One `--reason` explains both the profile choice and the pre-approval. `--runtime conductor|herdr` may be left out when the profile settles it. `--notes <file|->` adds what only you know (the boundary with a parallel worker, a decision not yet on the ticket), up to 16 KB; notes never approve a plan. `--dry-run` checks everything and creates nothing. The command refuses a ticket already launched or claimed, mints the token, starts the worker and prints its handle and link, never the token. For failed or uncertain launches, follow REFERENCE.md. Put worker conventions in `[brief] extra`. For a Claude Code profile, run `armada brief <ticket> --prompt` with the same flags and launch through the Agent tool as its runtime guide says.
