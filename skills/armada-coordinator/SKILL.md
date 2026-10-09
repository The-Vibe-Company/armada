---
name: armada-coordinator
description: Coordinating an Armada fleet of coding agents on one project. Use when designated coordinator, or asked to launch workers on ready tickets, answer their questions, merge their green pull requests, or resume a fleet in a new local or cloud session. Reads the fleet with armada status and armada inbox and drives workers through the runtime guide skill.
---

The coordinator turns the owner's intent into merged pull requests. Each worker owns one ticket and follows the `armada-worker` skill; the coordinator chooses what runs, answers questions, merges and reports. `armada.toml` names the program root, the label groups and the policy. `AGENTS.md` (or `CLAUDE.md`) holds the repository's own rules, and they win where they are stricter.

**Standing authority.** Unless the owner said otherwise, they delegate reversible technical decisions, plan approval and merging to you: act, then report. Escalate only product decisions, irreversible or outward-facing actions, and anything that spends money.

**Armada does the runtime work.** For Conductor and herdr workers, `armada launch`, `armada answer`, `armada peek`, `armada relaunch` and `armada merge` launch, deliver, observe, replace and archive by themselves. Read the runtime guide (`armada skill armada-runtime-conductor`, `-herdr` or `-claude-code`) only when a command reports a limitation, and for every Claude Code subagent: Armada does none of that for them.

This file is the loop. [MERGE.md](MERGE.md) covers merging; [REFERENCE.md](REFERENCE.md) covers the watch's options, named coordinators, silence rules, upgrades, specs, secrets and long jobs.

## Start

1. **Sign in.** `armada whoami` says whether this terminal is signed in and to which organization. If not: a person runs `armada login` and approves the code in the browser; a headless coordinator (a cloud workspace, CI) sets `ARMADA_API_KEY` to an organization API key an owner created, or runs `armada login --api-key`. Signed in, Armada gives each command the organization's keys and puts a one-time launch token in every brief, so no worker needs a key. Keys set in the environment still win. `armada doctor` checks the repository and the sign-in together.
2. **Take your name.** One project can have several coordinators, each with a name. Set `ARMADA_COORDINATOR=<name>` (a cloud workspace) or run `armada coordinator use <name>` (this checkout); without either the name is `default`. A named coordinator sees its own workers and unowned items; `default` sees the whole fleet. `armada coordinator list` shows the names, their sessions and tickets. See REFERENCE.md before sharing a project.
3. **Find your coordination ticket**, if the owner gave you one. Read its comments, newest first. A last comment `Agent status: released — <text>` is a hand-over: `<text>` is the state the previous coordinator left. Claim the ticket with your own handle, never the previous one: `armada claim <ticket> --runtime <your runtime> --handle <your handle> --branch <default branch>` (in Conductor, `--runtime conductor --handle "$CONDUCTOR_WORKSPACE_ID/$CONDUCTOR_SESSION_ID"`; elsewhere set `ARMADA_COORDINATOR_HANDLE` to the handle you claimed with). Report on it as a worker would, `armada report implementing --ticket <ticket> --message "<what you found and do next>"`, and hand over with `armada release --ticket <ticket> --reason "<state so far and what remains>"` when you stop before the run ends. Write that reason for a reader with none of your context.
4. **Run from anywhere.** Commands find the project from the checkout. From another folder, pass `--project <slug>` (this machine's last watched checkout) or set `ARMADA_CONFIG=/path/to/armada.toml`; `--config <path>` wins over both.

## Loop

Repeat these steps in order. Each ends on a "done when".

### 1. Read the fleet

`armada status --mine` and `armada inbox --mine`; without `--mine` they show the whole fleet. Never work from memory: a new session resumes from these two commands. Status lists the tickets in flight with their phases, the frontier of ready tickets, pull requests waiting, pending and deferred launches, open jobs, merge holds and the default branch's health. The inbox lists, oldest first, everything that waits for you; each entry says what to run.

Done when you can name every ticket in flight and its phase, every ready ticket, every pull request waiting and every open inbox entry.

### 2. Keep watching

You only learn of something new when a command you run ends. While a worker is in flight, keep exactly one `armada watch` running in the background (Claude Code: a Bash call with `run_in_background`). It waits until something needs you, prints it and exits, which wakes you. Act on it, then start it again. The last line of `armada inbox`, `watch`, `merge`, `launch` and `brief` says what to do: `2 workers in flight (ABC-1, ABC-2) — keep watching: armada watch`, `armada watch is already running (pid …)`, or `nothing to watch`. Follow it.

- Never write your own polling loop, `sleep` loop or transcript poller: `armada watch`, `armada peek` and `armada inbox` replace them.
- `armada watch --follow` keeps running and prints a line per event; use it only where every output line reaches you (a terminal, a herdr pane, a harness tool such as Claude Code's Monitor) or in a script. Pass `--for <minutes>` below your harness's command limit; it ends with the command that resumes it.
- `armada status` and `armada inbox` run fine beside a watch. Stop a watch only with `armada watch --stop`, never `pkill`.
- A runtime that cannot run a background command calls `armada inbox --wait` again and again instead.
- In Claude Code, the stop hook `armada init` installs refuses to end your turn while workers are in flight and no watch runs. `ARMADA_STOP_HOOK=off` turns it off; say so in your report.

Done when a watch runs, or the last line says `nothing to watch`.

### 3. Answer what waits for you

Work through the inbox, oldest first.

- **`question` and `plan`.** Decide, then `armada answer <item> "<answer>"`. For Conductor and herdr it delivers the text into the worker's session, posts it on the ticket and resolves the item, in one command; never send it a second time by hand. Repeating the same text after a failure is safe: Conductor deduplicates it. For a plan: read all of it, then `armada answer <item> "approved"` or concrete amendments with the reason. A plan item lists the worker's declared paths and their overlaps with other workers; a worker proceeds through overlaps on its own and asks only when it must change a contract another ticket relies on. A Claude Code worker: deliver with the runtime guide's *Message* section first, then `armada answer`.
- **Notes you start.** `armada answer --note <ticket> "<message>"` delivers and records a message the worker did not ask for. It also resolves that ticket's open plan without approving it: answer a waiting plan with `armada answer <item>` instead. A live herdr approval prompt (`runtime-blocked`) has no item id: read the pane with `armada peek`, then `armada answer <ticket> "<input>"`.
- **Product decisions** go to the owner: `armada ask-owner <ticket> "<question>" --choices "<a> | <b>" [--check "<check>"]` puts one question, judged in about a minute, on the owner's Validations page and prints the link to send. Never ask the owner to read a diff. Their pick returns as a `decision` item.
- **The owner's requests** from the dashboard, signed with their name:
  - `answer-request`: `armada answer <request id> "<the owner's answer>"`, which delivers and resolves the question or plan it names.
  - `launch-request`: launch the ticket as in step 5 (the claim resolves it), or decline it with `armada answer <request id> "<why>"` when it collides with work in flight.
  - Merge pressed on a pull request handed back at its current head goes straight into the merge queue, queued by the owner; no item arrives, so keep `armada merge --drain` running. A press the dashboard could not queue arrives as a `merge-request`.
  - `merge-request`, `release-request`, `plan-changes`: merge, release or relay the plan changes, then answer the item with what you did.
  - `decision`: an approved merge, `armada merge <pr>`; requested changes or a choice, deliver them with `armada answer`; an approved design ticket, `armada done <ticket>`, then cut the ticket that builds it, blocked by this one.
- **A missing secret.** A worker asks with `armada ask --secret <NAME>`. Run `armada secrets request <NAME> --ticket <id> --reason "<why>"` and send the printed link to an owner or admin, who types the value into the vault. Never ask for a value in chat; a pasted value must be rotated. When the inbox says `<NAME> is set`, tell the worker to re-run through `armada run`.
- **Other entries**: `hand-back` (step 6), `queue-stalled` (queued pull requests with no drain for 2 minutes: run `armada merge --drain`), `queue-refused` and `linear-pending` (MERGE.md), `hold` and `deploy` (step 7), `job` and `job-silent` (REFERENCE.md), `unblocked` (step 5), `stopped`, `silent` and `not-started` (step 4), `version` (run `armada upgrade`).

Decide reversible choices yourself and prefer the option that keeps behaviour observable. Shared numbers and names (migrations, ports, versions) are never yours to hand out: workers take them with `armada reserve`, and `armada reserve --list` shows the holders.

Done when the inbox shows no open question, plan or request.

### 4. Check stopped, silent and unstarted workers

Run `armada peek <ticket>`: the runtime's state, the worker's last reply, its recent commands, its report and heartbeat ages, its PR checks and open questions. It never writes to the worker.

- **`stopped`** (Armada saw the session idle in a working phase) or **`silent`** (no heartbeat, report or answer within its allowance): read the last reply. A worker that is merely idle gets a nudge with `armada answer --note`. A worker that died, failed or whose workspace is gone is replaced with `armada relaunch <ticket> --reason "<why>"`: it releases only the old worker, launches a new one on the same branch and pull request, then archives the old one. `--dry-run` shows the plan first.
- **`not-started`**: a launched worker that has not claimed. The entry says whether it never used its launch token or signed in and stopped before the claim. A worker stuck on a setup choice gets a note to take the safe option; one that is gone is relaunched, or its launch cancelled with `armada launch revoke <ticket>`.

Silence allowances, grace periods and wake-up levels are in REFERENCE.md.

Done when every worker in flight is working, waiting on someone, or replaced.

### 5. Launch ready tickets

One at a time, and only tickets that do not collide with work in flight.

1. `armada lint --ready` lists readability problems in ready tickets and open specs, each with its fix. Fix them on the ticket, then `armada lint <ticket>` to recheck.
2. Pick a ticket from the frontier in `armada status`. Read it and its parent spec.
3. **Choose the profile.** A `[[conductor.routing]]` rule matching the ticket's labels wins. Otherwise, when profiles have `when` rules, match them in plain words to the files and work the ticket will change, and pass `--profile <name> --reason "<why>"`. Mixed work goes where most of it is; say so in the reason. Override a label rule only when the labels mislead, with the same flags.
4. **Judge owner validation** when `armada.toml` has `[[policy.validation]]` rules: `--validation none` for most tickets, or `--validation <n> --validation-reason "<why>"` when one applies (a design ticket, a new screen's look).
5. **Pre-approve the plan** when it needs no review: `--pre-approve --reason "<why>"`. Otherwise the worker posts its plan and waits for your answer.
6. **Launch** Conductor and herdr workers with one command:

```sh
armada launch ABC-12 --runtime conductor --profile backend --pre-approve --reason "CLI and core only; a small follow-up" --notes notes.md
```

One `--reason` explains both the profile choice and the pre-approval. `--runtime conductor|herdr` may be left out when the profile settles it. `--notes <file|->` adds what only you know (the boundary with a parallel worker, a decision not yet on the ticket), up to 16 KB; notes never approve a plan. `--dry-run` checks everything and creates nothing. The command refuses a ticket already launched or claimed, mints the token, starts the worker and prints its handle and link, never the token. Put conventions every worker needs in `[brief] extra`, not in notes. For a Claude Code profile, run `armada brief <ticket> --prompt` with the same flags and launch through the Agent tool as its runtime guide says.

7. **A ticket blocked by work in flight**: `armada launch <ticket> --when-unblocked [--profile <name>]` remembers the launch. Merging its last blocker with `armada merge` launches it in the same run; when it cannot (a Claude Code profile, no ready label, a launch that fails), the merge prints the command to run and the request stays. A blocker closed elsewhere wakes your inbox with the launch command. Another coordinator's merge that unblocks your ticket arrives as an `unblocked` entry.
8. **Check the claim** a few minutes later: `armada status` shows the ticket in flight, phase `planning` (then `implementing` once a pre-approved worker posts its plan), with the handle the launch printed. A claim can report the worker `blocked` at once when Git refuses its pushes or commit signing would prompt: fix the access and answer it.

Done when every launched ticket is In Progress with a claim, and a watch runs.

### 6. Merge handed-back pull requests

A hand-back shown as `queued in the merge queue (position N)` or `merging: <drain step>` needs no new action; keep the drain running. A note that sends a worker back to work leaves the hand-back until that worker reports its resumed phase, which clears it; its next `ready-to-merge` report wakes the watch again.

A `hand-back` entry means the worker reported `ready-to-merge` with green CI, resolved review threads and the full head SHA. Merge it with `armada merge <pr>`, following [MERGE.md](MERGE.md). The command checks everything, merges pinned to the handed-back head under the project's merge lock, and then, by itself:

- archives the merged worker's workspace once GitHub confirms the merge (never archive by hand before that; `--no-archive` keeps it);
- tells the working workers it concerns that main moved: those whose open pull requests share files with what landed, or all of them when `[merge] notify_paths` matched or the file reading was incomplete (never send those notes yourself);
- closes the ticket, closes its spec when it was the last open ticket, and lists the tickets it unblocked, launching those you deferred when it can;
- starts the deploy check when `[[deploy.target]]` is set;
- ends with one `Result:` line. Read it: `Result: merged #N` is done; `Result: not merged (…)` confirmed no merge (if it says `merge unconfirmed`, look at GitHub before retrying); `Linear pending` means run `armada merge --finish <pr>` once Linear answers.

Workers hand back without chasing main, so a head is often behind: add `--wait`, which updates it on GitHub and waits for its checks (without it, a behind head is refused unless `[gates] local_commands` can test-merge it). Several hand-backs at once: queue them with `armada merge --when-green <pr...>` and run `armada merge --drain` in the background; it merges them one at a time, each retested on fresh main. With `[policy] merge_approval`, judge each pull request and pass `--reason "<why>"`, or `--ask-owner --reason "<why>"` to send it to the owner first. A hand-back with `--more-prs` keeps its ticket and worker open after the merge; `--keep-open` and `--close` override that.

Done when the pull request is merged, the result line says so, and nothing it printed is left to do.

### 7. Keep main healthy

- **Merge holds** pause merges for every coordinator: `armada hold` lists them, `armada hold add "<reason>"` opens one. Merge the fix with `armada merge <pr> --through-hold "<why>"`, verify the recovery, then `armada hold clear <id> --reason "<what was verified>"`. Never clear a hold just to let a merge through.
- **Main red.** `armada status` says `main red since #N` with the failing checks, and whether a fix is running. Find the cause with `armada ci why --branch <default branch>`, cut a fix ticket, and hold merges when the breakage would spread.
- **Deploys.** With `[[deploy.target]]`, each merge starts a watcher; a failed deploy or smoke check puts a `deploy` item in your inbox and opens a hold. `armada deploy status` shows the targets. Merge the fix through the hold; the next healthy deploy clears it.
- **Red checks on a pull request.** `armada ci why <pr>` names the failing tests, first errors and runner problems. `armada ci why <pr> --rerun` reruns once only when every failure is a runner problem or a declared `[[ci.known_failure]]`, and names each flake's root-cause ticket. Anything else is a real failure: send it back to the worker.

Done when no hold is open without a ticket that fixes it.

### 8. Turn findings into tickets

A gap a worker reports or a bug you see becomes a ticket under the right spec, with its blocked-by relations, and is launched when ready. No finding lives only in a transcript. `armada spec add "<name>"` creates a spec under the program root with the **In short** template; fill it in before cutting its tickets, then `armada lint <ticket>` each one. Inserting or renumbering specs is in REFERENCE.md.

### 9. Report to the owner

When the owner asks where things stand, run `armada digest` and paste its text; `--since 4h` sets the window and `--send` posts it through the organization's channel. The summary includes deploy target states and long jobs with reported progress and estimated ends; when work spans several specs, it groups merged, waiting and in-progress tickets by spec with done/total counts. Owner validations and questions also reach that channel by themselves (Organization > Notifications). Report in the owner's language (`[tracker] language`): what merged, what runs, what you decided for them, and the one thing they must do, with its exact place. Outcomes and numbers, no process narration.

Then repeat from step 1.

## Rules of thumb

- Never pipe Armada commands through `grep`, `tail` or `head`: their last lines say whether something happened and what to do next.
- Long runs (an evaluation, a backfill) go through `armada job`, never in your session or a worker's.
- Parallel workers in one area collide: stagger them, or give each a disjoint area and say the boundary in `--notes`.
- Evidence for the owner goes through `armada attach <ticket> <files|urls>... --caption "<what to check>"`; link the printed URLs. Screenshots stay out of git.
- Everything that must outlive your session goes to the tracker or the repository.
- When a command named here is missing from your Armada version (`armada --help`), run `armada upgrade`; if you cannot, do the step by hand with the same protocol and say so in your report.
