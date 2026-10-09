# Armada

Armada runs a fleet of coding agents on one project and keeps every piece of work visible.

It imposes one method: grill the decisions, write a spec, cut it into tickets, let one worker agent ship each ticket as a green pull request, and let a coordinator agent merge. The tracker is the source of truth for progress; Armada adds live telemetry, contention rules and a fleet dashboard on top.

**Status:** early; the CLI and dashboard run the full ticket-to-pull-request workflow.

## What Armada does for you

- Launch one worker per ready ticket, preserve its session and progress, and let named coordinators resume the fleet.
- Route questions and owner approvals to the dashboard; send owner alerts and scheduled digests through a configured chat webhook.
- Keep merges under shared holds and a durable queue, notify affected workers, and require live acceptance checks when configured.
- Explain CI failures, rerun declared flakes once, check deployments and smoke tests after merges, and track long jobs on your runner.

`armada doctor` points out optional configuration. Enable what your project needs in `armada.toml` and Organization > Notifications; the [runbook](docs/runbook.md) covers each feature.

## Install

Requires [Node.js](https://nodejs.org) 22 or later: `npx` and `bunx` both run the command with Node.

```sh
npx @the-vibe-company/armada status     # or: bunx @the-vibe-company/armada status
npm install -g @the-vibe-company/armada  # then: armada status
```

`armada --version` prints the installed version, `armada --help` every command and `armada <command> --help` one. When a command cannot continue, it prints the reason and a `Next:` line with the command to run, for example `armada init` in a repository without `armada.toml`. Each release is listed on [GitHub releases](https://github.com/The-Vibe-Company/armada/releases) with its changelog.

## Set up

1. **Create the organization.** Sign in to Armada ([armada.thevibecompany.co](https://armada.thevibecompany.co), or [your own deployment](#watch-the-fleet-dashboard)) with GitHub, create your organization and invite the others.
2. **Enter the keys** once, on Organization > Keys: the Linear API key. It stays sealed in Armada: no laptop or runtime needs it, and no machine needs a database key either, since the CLI reaches the fleet's live data through Armada ([Keys](#keys)).
3. **Sign in from the terminal**: `armada login`, then approve the code in the browser. A headless coordinator sets `ARMADA_API_KEY` to an organization API key instead ([Sign in from a terminal](#sign-in-from-a-terminal)).
4. **Set up the repository**: `armada doctor` lists what it lacks, `armada init --program-root ABC-1` opens one pull request that adds it all ([Set up a repository](#set-up-a-repository)); merge it.
5. **Choose optional features.** Use the commented template and doctor’s `info` lines to configure deployment targets/smoke checks, known flakes and `[ci] setup_steps` for tool/dependency download outages before tests (exact names or `*` globs; 4xx stays a failure), acceptance checks, jobs and owner approval rules. Enable owner alerts/digests on Organization > Notifications, then select each coordinator’s name with `armada coordinator use <name>`. Launch cloud workers with `armada launch ABC-12 --runtime conductor`. For an existing checkout, follow [Upgrade an existing project](docs/runbook.md#upgrade-an-existing-project).

```sh
armada login
armada init --program-root ABC-1
armada status       # or: armada status --json
```

Workers then need no key either: each one's launch message carries a one-time token, and Armada gives it its keys ([Launch a worker](#launch-a-worker-coordinators)). Without an Armada that keeps keys (a self-hosted one without accounts, CI), set the keys in the environment or run `armada auth login` ([Keys](#keys)).

`armada status` reads the `armada.toml` of the current repository (or the nearest parent directory) and prints:

- **In flight**: tickets an agent holds, with their phase, runtime, last report and pull request. A worker with no heartbeat for longer than `policy.silence_minutes` is flagged `silent`, unless it is waiting on a human (`awaiting-approval`, `blocked`, `ready-to-merge`). Older workers without heartbeats fall back to reports (an `armada report` event recorded through Armada, an `Agent status:` comment or its claim), then the ticket's last sign of life (ticket edit, comment or pull request update). A live worker without a report for `policy.quiet_minutes` gets a coordinator-only inbox note, not a red dashboard state.
- **Failed or uncertain launches**: `launch-failed`/`launch-uncertain` reach the coordinator’s inbox immediately and wake the watch, including launches during merge/drain. Follow the item’s `Next:` command; inspect an uncertain launch before retrying. These launches exit 1 (preflight refusals exit 2). Launch output and dry-run plans show the ticket title; JSON includes `title`. Claim, successful binding, revoke or `armada answer <id> "<why>"` closes the item; while open it suppresses `not-started`.
- **Launched, not started**: signed in to Armada, the workers launched with a launch token that have not claimed their ticket after `policy.not_started_minutes`, each saying whether the token was never used (the worker never reached its `armada login` line) or used without a claim.
- **Ready to start**: tickets without sub-issues that are not started, not held by an agent, have no open pull request, and whose blocked-by tickets are all closed, ranked by what they unlock. Tickets without the ready label, or still in triage, are listed separately.
- **Pull requests waiting**: open pull requests with their CI state and mergeability.

GitHub is read with `GITHUB_TOKEN`, `GH_TOKEN` or the GitHub CLI login (`gh auth token`). Without any of them the tickets are still shown.

## Set up a repository

```sh
armada doctor                          # what this repository lacks, with the fix for each
armada init --program-root ABC-1       # one pull request that adds it all
armada skill armada-worker            # read instructions from the installed CLI
armada skill armada-coordinator MERGE.md # read a linked file
armada skills update                  # update pointers and vendored skills on your branch
```

`armada doctor` checks, in the repository you are in:

- `armada.toml` exists and is valid;
- the five `armada-*` skills are discovery pointers in `.agents/skills`, linked from `.claude/skills`; their descriptions trigger Claude Code and Codex to run `armada skill <name> [<file>]` and follow the installed CLI version. `skills-lock.json` records their pointer hashes with `sourceType: "armada-cli"` and a tagged GitHub source link. The scripted `ship-pr-dev`, `review-code-dev` and `capture-learning-tools` packages stay fully vendored and checked by their folder hashes;
- `.conductor/settings.toml` has a `[scripts] setup` command;
- `.gitignore` ignores `plans/ship-pr-dev/`;
- this terminal is signed in to Armada, and to which organization: without a sign-in, `armada brief` gives workers no launch token, so each would need the keys in its environment;
- this CLI is as recent as that Armada expects (signed in only): every answer of the Armada API names the oldest CLI that reads it right and the latest one, and a CLI older than the oldest prints one line on any command, `Armada <version> is older than this server expects: npm install -g @the-vibe-company/armada@<latest>`;
- no key is left in the credentials file that Armada now gives this terminal (`armada auth logout` removes them, the sign-in stays);
- commit signing: known password-manager signers and GUI pinentry warn when signing may wait for a person. `armada doctor --deep` explicitly tests a signed throwaway commit object with a 10-second limit and moves no refs; the default check never signs. GitHub-required signatures are an error when signing is disabled locally or `[git] sign = "off"`;
- the Linear label groups `Agent phase` and `Agent runtime` exist with every value (needs a Linear key, from Armada or `LINEAR_API_KEY`);
- with Conductor profiles in `armada.toml`, the `conductor` command is found: on PATH, or inside the macOS app at `/Applications/Conductor.app/Contents/Resources/bin/conductor`, with the fix that puts it on PATH.

Each problem is an error or a warning, with its fix. A missing skill, or a CLI older than Armada expects, is an error: workers cannot run without it. A skill that differs from this Armada version, a missing ignore line, a missing sign-in or a leftover key is a warning. Doctor exits 1 when there is an error. `--json` prints the same report as JSON.

After the one-time pointer conversion, instruction-only Armada releases need no setup PR or project CI run. Doctor and status compare pointers, so only a discovery description change (or a missing or edited pointer) needs a setup update. The source link keeps its recorded tag until the pointer changes. Workers install the brief's pinned version before reading their skill; if `armada skill` is missing, install that version first. The command works offline, without sign-in or a checkout.

New releases leave the coordinator's watch running. `armada status` and `armada inbox` announce them at most once per 24 hours per machine, across release versions; the dashboard's coordinator card shows update availability. Setup behind gets a separate daily notice in status, inbox and plain watch's final output: run `armada upgrade`, then merge the setup pull request it opens. Only a CLI below the server minimum produces a `version` item and stops either watch mode. Plain watch lists other coordinators' items with their owner, but wakes only for new own and unowned items, even with `--all`. Reading inbox preserves the watch's shown history; a narrower `--mine` read cannot prune a broader `--all` read. Run `armada upgrade`: it waits up to five checks over about two minutes for npm to serve the exact target, installs it, verifies `armada --version`, then uses the installed doctor to check setup. It runs `armada init --merge` only for outdated setup, through the normal setup-only merge checks. Upgrade requires the selected checkout's `armada.toml` at its Git root. Workers keep their brief's pinned version.


The shipping skills include every helper, reference, eval, companion manifest and license.
`armada doctor` also checks Python 3.9+, Git 2.41+ and the checksum-pinned OCR 1.12.1
cache without downloading or executing OCR. Its first bootstrap requires GitHub
HTTPS access and a writable cache (`REVIEW_CODE_OCR_HOME` optionally overrides
`~/.local/share/review-code-dev/ocr`). Delegation uses an isolated host reviewer;
no additional API key, Alibaba service or OCR LLM endpoint is needed. See the
vendored `review-code-dev` setup notes for supported platforms and exact fixes.

`armada init` fixes the repository setup in one go:

1. It creates the missing Linear labels (a missing group goes in the team of the program root).
2. It builds the missing or outdated files on a fresh checkout of the default branch, commits them on the stable branch `armada/setup` and opens a pull request with `gh`. Your own checkout is not touched. Running it again, including with a newer CLI version, rebuilds that branch and updates the same open pull request. The first run replaces legacy `armada/init-*` pull requests, closing each with a link to the replacement. When the default branch already has everything, no pull request is opened.
3. It registers the project (slug, name, repository, program root) on Armada, for the organization the terminal is signed in to, so `armada status --all` and the dashboard list it. A slug another organization already holds is refused.

`armada init --merge` waits for the same checks as `armada merge <n> --no-ticket --wait` and merges the setup pull request itself. It refuses changes outside `.agents/skills/**`, `.claude/skills/**`, `skills-lock.json`, `.conductor/settings.toml`, `.claude/settings.json` and `.gitignore`; `armada.toml` is allowed only when the default branch has none.

To update the bundled skills on an existing ticket branch, run `armada skills update`.
It uses init's pointer and vendoring rules for skills, links, `skills-lock.json` and the shipping
artifact ignore, in the current checkout. It requires Git, but no sign-in, Linear
key or network. Review and commit its changes yourself; it does not open a setup PR
or edit `armada.toml`, Conductor scripts or Claude hooks. It replaces locally edited
bundled skills and removes files dropped by their current package; other skills and
their lock entries stay. Use `armada init` for the full setup PR.

On a repository without `armada.toml`, pass `--program-root <ISSUE-ID>`; the name comes from the GitHub repository unless you pass `--name`, and the slug from the name unless you pass `--slug`. An existing `armada.toml` is never replaced. `init` needs `git`, the GitHub CLI logged in (`gh auth login`), a sign-in to Armada (`armada login`), and the Linear key, from Armada or from `LINEAR_API_KEY`; on a terminal it asks for a missing key first.

`armada status --all` prints the status of every project registered for the organization the terminal is signed in to, each read with the `armada.toml` on its repository's default branch. A project that cannot be read shows its error without hiding the others.

## Launch a worker (coordinators)

Armada starts [persistent local workers through herdr](#run-workers-on-your-own-machine); Conductor and Claude Code subagents follow their runtime guides. The `armada-runtime-conductor` skill gives the exact Conductor Cloud commands; the `armada-runtime-claude-code` skill launches a worker as a background subagent of a coordinator running in Claude Code, in its own git worktree (it dies with the coordinator's session, so long runs go to Conductor or a persistent herdr worker). [`docs/runbook.md`](docs/runbook.md) says how to start a coordinator on a laptop or in Conductor Cloud, what the owner sets up once, and how one coordinator hands over to the next.

```sh
armada brief ABC-12                    # read-only settings and prompt preview; no launch
armada brief ABC-12 --prompt --profile-line  # prompt on stdout; profile and reason on stderr
armada brief ABC-12 --profile codex --reason "a back-end bug behind a web label" --json
armada launch revoke ABC-12            # cancel the newest pending launch through Armada
```

- The prompt names the ticket and its Linear branch, starts by installing the coordinator's Armada version (`npm install -g`, with an `npm exec` fallback), signing in with `armada login --launch-token <token>` and running `armada claim` with the handle `$CONDUCTOR_WORKSPACE_ID/$CONDUCTOR_SESSION_ID`, and carries the blockers with their hand-back notes, the comments already on the ticket and the workers in flight.
- **Plan rule.** A "Plan" section says in one line whether the worker waits for approval: "post your plan with `armada report implementing --plan-file -` and go on" when plans are pre-approved, "post your plan with `armada report awaiting-approval --plan-file -` and wait for approval" otherwise. `[policy] plans` decides (`approve` by default, or `pre-approved`); a ticket labelled `plan-approved` (`policy.pre_approved_label`) is pre-approved, and one labelled `needs-plan-approval` (`policy.approval_label`) waits for approval, which wins when a ticket has both. The settings show the rule and where it comes from (`Plans:`), and `--json` carries it as `plans`.
- **Project conventions.** `[brief] extra = "<path>"` names a file of the repository (relative to `armada.toml`) that every prompt ends with, under "Project conventions": the checks to run, the generated files to refresh, how to bring main in. A missing file is a brief warning, and `armada doctor` checks it.
- **Workers need no key.** Only `brief --prompt` asks Armada for a launch token: one ticket, used once, valid one hour. Human and `--json` views are read-only, mint no token and add no worker to watch state; they show `Launch: a one-time token is made when you print the prompt (--prompt)`. With `--prompt --profile-line`, stdout remains the exact worker prompt and stderr gives the selected profile, agent, model, effort, runtime and reason: one call supplies both the prompt and runtime settings. The worker exchanges the token for a session limited to its ticket's `claim`, `report`, `ask` and `release`, and Armada gives each command its keys. Make the prompt right before the launch; its token is the only secret a prompt ever holds, useless once used. The launch message is the `--prompt` output only, never either preview. Without a token, the profile line's `Launch:` summary says why (not signed in, or an Armada without accounts or keys).
- **Cancel a launch.** `armada launch revoke <ticket>` ends the newest pending launch through the API and records the same revocation audit as Organization > Workers. It also cancels a worker that signed in but never claimed; a claimed worker is refused with the `armada release` hint. Owners and admins can revoke, including an organization API key whose creator still has that role. `armada status` lists pending launches with the cancel command.
- **Unused launches clear.** Once an unused launch token expired more than an hour ago, it stops being followed. The next coordinator inbox read ends it server-side, shows one `not started (token expired)` notice, then clears it. Exchanged-but-unclaimed launches remain revocable and stop being followed after the existing 24-hour window from their launch.
- **A version npm serves.** The brief pins the coordinator's Armada version after checking npm's metadata and that the tarball answers HEAD with HTTP 200 (3 s total at most, beside the Linear reads). When npm does not serve it yet (a release still publishing, a checkout ahead of npm), the brief pins the newest downloadable stable version no higher than the coordinator's build and warns; offline, it only warns. The server uses the same check for release notices and watch version items, cached for five minutes and refreshed after a CLI response, never blocking it. A cold cache stays quiet; an outage keeps the last verified version. Merging or releasing the ticket ends the worker's session, and Organization > Workers on the dashboard revokes one.
- The settings give the profile's agent, model and effort from `[conductor]` in `armada.toml`, and the environment variables: `ARMADA_TICKET=<ticket>`, and, only without a launch token, `LINEAR_API_KEY` (required). Each shows whether this shell has it. No value is ever printed.
- A profile with `runtime = "claude-code"` routes the launch to the `armada-runtime-claude-code` skill: the `Runtime:` line names the skill, the claim runs `--runtime claude-code` with the subagent's name as its handle (the ticket id in lowercase), and the prompt first makes the worker check it runs in its own worktree. The Agent tool applies no effort; the brief says so.
- Label rules win: the first `[[conductor.routing]]` rule with a label the ticket carries (case, spaces and punctuation ignored) selects its profile. Otherwise, profiles with `when = "front end: dashboard pages, components, styles, design, UI copy"` or `when = "back end: CLI, core rules, API, database, migrations, tests, docs"` ask the coordinator to choose. `armada brief ABC-12` prints **Choose a profile**, the ticket's title and In short, and every profile's rule; it creates no launch token or watch entry. `--json` returns the choice information; `--prompt` refuses until a profile is chosen. Read the ticket and parent spec, choose the rule covering most files/work (explain mixed work), then run `armada brief ABC-12 --profile codex --reason "mostly CLI and core rules" --prompt`. Armada does not call a model to classify tickets. Projects without `when` keep their old `conductor.default_profile` or only-profile fallback.
- `--profile` also overrides a label route. `--reason` is required for semantic choices and, when routing rules exist, overrides of the routed profile. Keep both flags on subsequent `--prompt` calls. The generated claim command carries the reason; the claim comment, `armada status` and dashboard agent Profile row show it. An unknown profile exits 2. The dashboard's ready-to-launch row shows a label-routed profile or "chosen by the coordinator"; Launch still sends an inbox request, not a runtime call.

## Tracker conventions

Run `armada lint --ready` before launching workers. It checks tickets on the frontier carrying the project's ready label and all open specs under the program root. `armada lint ABC-12 ABC-13` checks named tickets in the program; combining names with `--ready` checks their union. Each finding gives the problem and its fix; `--json` returns the same diagnostics.

Tickets and specs should have an `## In short` section with **What changes**, **Why**, **Done when** and **Depends on** parts (a standalone heading or label, or followed by a colon or period). Titles describe an outcome in plain words, at most 60 characters: keep backticks, paths, file extensions, camelCase, snake_case and function parentheses in the technical detail. Spec titles accept both `Spec N — Name` and `Spec N/M — Name`; the length limit counts only the name. There is no starting-verb check, since it would misfire across languages.

Without a lint table, these defaults produce warnings and exit 0. Add the table to enforce errors (exit 1), overriding only the rules your project needs:

```toml
[tracker.lint]
in_short = "## In short"
in_short_parts = ["What changes", "Why", "Done when", "Depends on"]
title_max = 60
```

`armada brief` reports the same findings as warnings above its prompt and still produces it. With `--prompt`, warnings go to stderr before the prompt on stdout. Description reads for lint are batched in one flat Linear query per page; dashboards and polls never run them. A failed or incomplete read exits nonzero rather than claiming tickets passed.

## Run workers on your own machine

Workers do not have to run in Conductor Cloud. With [herdr](https://herdr.dev) 0.9.1 or newer, the coordinator runs each worker on this machine, in its own git worktree and terminal, and the worker keeps going when the coordinator disconnects (the machine must stay awake). Four harnesses are supported: `claude`, `codex`, `opencode`, and `deepseek`, which runs a persistent OpenCode session with the DeepSeek model you configure. Add a local profile to the project's `armada.toml`:

```toml
[herdr.profiles.backend]
harness = "codex" # claude, codex, opencode or deepseek (OpenCode + DeepSeek model)
model = "your-model-id" # exact id: `opencode models` lists them for opencode and deepseek
effort = "high"
extra_args = ["--sandbox", "workspace-write"] # arguments for this harness only
```

Label routing follows the same rules as the Conductor profiles (`[[herdr.routing]]`). Launch from the signed-in coordinator; the worker's brief carries a one-time launch token, so it needs no key:

```sh
armada launch ABC-12 --runtime herdr --profile backend --reason "back end work"
```

`[git] sign = "inherit"` (the default) keeps signing configuration in new Herdr worktrees. Use `sign = "off"` only when branch rules allow unsigned commits: launch enables `extensions.worktreeConfig` and writes `commit.gpgsign = false` in the new worktree only. Repositories with common `core.worktree`, `core.bare = true` or `core.sparseCheckout = true` need those settings migrated to per-worktree config first; launch reports the fix instead of changing their meaning. If an included config still enables signing after the worktree override, launch stops before starting the worker and names the fix. Conductor Cloud workspaces keep their environment’s own signing configuration.

`armada doctor` checks what the local profiles need: herdr (0.9.1 or newer), each harness CLI, the Claude and Codex sign-ins, and every OpenCode or DeepSeek profile's exact model against `opencode models`. On a terminal it offers the official installs and a numbered model pick, each only with your consent; `--json` and CI only print the fixes. Armada never runs a sign-in and never handles a provider key. The runbook's [Launch a persistent local worker](docs/runbook.md#launch-a-persistent-local-worker) has the rest: routing and model choice, messaging the worker, and safe archival with `armada stop`.

## Work on a ticket (workers)

A worker writes to the tracker only through three commands. They set the labels and write the comments in the protocol format, and record each event on Armada with the worker's sign-in.

```sh
armada login --launch-token <token>        # the first line of the launch message: no key needed after it
armada claim ABC-12 --runtime conductor --handle <workspace>/<session>
armada report awaiting-approval --plan-file plan.md        # the plan as its own block, one-line status
armada report implementing --message "plan approved, writing the parser"
armada attach ABC-12 .context/overview.png https://example.com/design --caption "Check the new overview"
armada report implementing --message "parser done, wiring the CLI"   # same phase = status update
armada report shipping --message "PR open" --pr 34
armada report ready-to-merge --pr 34 --sha <full 40-character head SHA>
armada release --reason "wrong ticket"
```

Set `[policy] max_workers = 10` to cap project-wide worker sessions, including workers waiting for merge and launches that have not claimed yet. Coordinator sessions and waiting launch requests use no slots. At the cap, `armada launch` creates nothing: use `armada launch ABC-12 --when-unblocked` to wait for a slot or `--over-cap "<why>"` to launch anyway. Linear Urgent priority passes automatically. Bypasses carry their count and reason in pending-launch status and the activity feed; `brief --prompt` enforces the same cap, and relaunch replacements are exempt. Status shows `Workers 8 of 10`; watch lists waiting launches separately and keeps listening for their slot. Lowering the cap stops no running worker. Deploy the API migration before using the new CLI; older CLIs ignore this opt-in policy.

`armada attach <ticket> <file|url>... [--caption "<text>"] [--for <item>]` keeps visual evidence out of git. It uploads byte-checked PNG, JPEG, WebP or GIF images (at most 2 MB each) and records HTTPS links, then prints private dashboard URLs. An organization member opens them from those URLs or ⌘K (search a caption); a validation's images show on its Validations page, enlarged on a click. The bytes stay in the app's Postgres and are served only after organization/project access checks; signed-out callers and other organizations receive 403. Worker sessions attach only to their own ticket; coordinators attach to any ticket in their project's cached reading. Refresh the dashboard first if a new ticket is missing there. `--for` stores a free validation reference. Identical content on a ticket is stored once (a later `--for` can bind it to a validation). Each ticket defaults to 20 images/links, the project to 200 MB of image bytes, and evidence is deleted by the next successful project refresh at least 30 days after completion or cancellation; reopening resets that window. Configure these limits in `[policy]` below. Never include credentials or secrets in linked URLs or screenshots.

- `claim` re-reads the ticket and refuses it when another worker holds it; if two claims race, the older comment wins and the other withdraws. It assigns the ticket to the Linear key's user, moves it to the team's first started state, sets the `planning` phase label and the runtime label (matched by name, so `conductor` finds `Conductor`), and posts an `Agent claim — runtime · session · branch · started` line. The handle is kept in that comment and on Armada, so a coordinator finds the session either way. Claiming again with the same handle repairs labels and state. It reads every comment and label of the ticket, however many.
- `report <phase>` accepts: planning → awaiting-approval or implementing; awaiting-approval → planning or implementing; implementing → shipping; shipping → implementing or ready-to-merge; ready-to-merge → shipping; planning, implementing or shipping → awaiting-validation (what `armada validate` reports) and back; blocked from anywhere and back to any phase; the current phase again as a status update. Anything else exits 1 with the reason. The output lists what waits in the worker's inbox.
- `report`, `ask` and `answer` accept `--message-file -` to read standard input to EOF, including a pipe or a shell heredoc. For example: `printf 'line one\nline two' | bun run armada report implementing --ticket ABC-12 --message-file -`. An explicitly empty or whitespace-only message file or stdin exits 2 before any tracker or database write, with a retry naming `--message` or a non-empty pipe. A `ready-to-merge` report may still omit the message option.
- `--plan <text>` or `--plan-file <path|->` posts the plan as its own `## Plan` block under the status line. `--message` becomes optional: its first line is the status, else the plan's first line (cut at 100 characters). `armada status` then shows that one line and `plan: <comment url>`, and the dashboard's status line gets a "plan ↗" link. Only one of `--message-file -` and `--plan-file -` can read standard input.
- `claim` and `report` read the ticket back and print where it stands, for example `Now: In Progress · phase implementing · runtime Conductor · profile none`, so a worker can check it without opening Linear. `--json` carries the same as `state`.
- `ready-to-merge` is refused unless the pull request is open in the project repository, `--sha` is the full 40-character SHA of its head, and every check in `[gates] required_checks` is green on that head (with none declared: at least one check, all green). It needs a GitHub token.
- `release` removes the phase and runtime labels, keeps the configured ready label so the ticket can be taken again, moves the ticket back to the team's first unstarted state and posts `Agent status: released — <reason>`.
- `report` and `release` find the ticket from `--ticket`, then `ARMADA_TICKET`, then the current git branch (`feature/abc-12-…`).
- The live record is optional. When the terminal is not signed in to Armada, or Armada cannot be reached, the commands still write Linear and print a warning. A worker session acts on its own ticket only: Armada refuses it anything else.

## Plans, questions and answers

```sh
armada ask "Which store keeps the sessions? I recommend SQLite." --options "SQLite | Redis"   # worker
armada inbox                   # coordinator: what waits, oldest first
armada watch                   # coordinator, in the background: returns when something needs you
armada inbox --wait            # returns when a new item arrives, or after --timeout (default 300 s)
armada ack '#12' --reason "No further action needed" # deliberately skip a notice, with the reason on its ticket
armada answer 12 "SQLite, for the first slice."                 # after delivering it in the worker's session
armada answer 13 "approved"                                   # a plan, after delivering approval
armada answer --note ABC-12 "main moved: bring it in before you ship"  # an unsolicited message, same path
```

- Hand-backs already in the merge queue show their position or drain step as in progress in the inbox, watch and dashboard. They need no new coordinator action. A worker reporting another phase clears its previous hand-back; its next `ready-to-merge` report wakes the watch again. Confirmed merges clear that PR's queue refusals and owner merge requests, with cleared ids in the result line. The next inbox read also clears notices for PRs merged elsewhere, using the stored GitHub reading.
- `ask` reports the `blocked` phase with `Agent status: blocked — question: <first line>` (the rest and the numbered options below it) and adds a `question` item to the coordinator's inbox on Armada. The worker then stops and waits for the answer in its session, and reports the phase it resumes. It finds the ticket like `report`.
- `report awaiting-approval` adds a `plan` item with the full message (and the `--plan` block) and worker handle to the coordinator's inbox. Same-phase heartbeats neither duplicate nor reopen it. Answering it, recording a note, leaving the phase or releasing the ticket closes the plan and any pending approval request. For a pre-approved plan (the brief's "Plan" line says which), post the plan with `report implementing --plan-file -` instead: no approval item is needed.
- Long runs go through `armada job`, on the project’s runner. A running job whose progress stays unchanged past `[jobs.<name>] stall_minutes` (default 60) shows `stalled N min` in job list/status and a stalled tag in the job strip, and creates one `job-stalled` inbox wake per stall. Check with `armada job status <id>` and stop deliberately with `armada job stop <id>`. Fraction progress (`n/m`) ignores changing ETA/clock text; movement clears the alert. Silence takes precedence; absent progress is never stalled. The alert never stops a job and only covers runs tracked through Armada jobs.
- `heartbeat --every 5m --parent <agent-pid>` pings Armada without reading keys from the vault or writing Linear. The brief starts it immediately after claim: Conductor uses `--background` (detached process group and PID file), Claude Code uses the subagent's background Bash. It survives between turns on Cloud and stops when its persistent parent exits or the current worker session ends (release, merge, revoke). If background startup is unsupported or fails, keep manual reports at least every 15 minutes. `[policy] silence_minutes` defaults to 15: no heartbeat means probably stopped; old clients use reports. `quiet_minutes` defaults to 45: alive without a progress report creates a coordinator-only `quiet` inbox note, never an owner item or red dashboard state. Heartbeats draw the timeline's session line; actual reports remain dots.
- `inbox` lists the coordinator's open items (questions, plans, requests, hand-backs), silent workers and workers that never started, oldest first. A worker never started (`not-started`) was launched with a launch token and has not claimed its ticket after `policy.not_started_minutes`; the entry says whether the token was never used or used without a claim, names the worker's session when its sign-in gave one, and clears on the claim, when the launch ends (release, merge, revoke) or when a newer launch of the ticket replaces it. A launch on a ticket a session still holds is not followed (a brief made to read a running worker's prompt again launches nobody; a relaunch releases the old claim first). A launched worker counts as in flight from its launch until it shows as not started, so `armada watch` waits for its claim; past that, its entry carries it. A worker is silent when it holds a ticket, its last heartbeat (or newest report for an older client) is older than `policy.silence_minutes`, and its phase does not wait on someone else. A live worker with no report for `policy.quiet_minutes` gets a softer `quiet` entry here only. It reads Armada only (a sign-in, no Linear key) and records that the coordinator is at work, for the dashboard. `--wait` asks Armada every 15 s until `--timeout`; Armada answers "not modified" (HTTP 304, no body) while the inbox holds the same entries, so a waiting coordinator costs one short request per ask and holds nothing open. It marks the items that were not there before with `*`; loop on it. A hand-back handed back again on a new head (or a plan rewritten in place) counts as new.
- `watch` is how a coordinator keeps listening, run in the background while a worker is in flight. It asks Armada like `inbox --wait` (every 15 s, every 60 s when no worker is in flight, 304 while nothing changed) and exits as soon as something needs the coordinator that it has not been shown yet by `inbox` or `watch` on this machine: it prints the inbox, new items marked `*`. It exits with "nothing to watch" when no worker is in flight and nothing is open. Armada unreachable or answering 5xx only prints a warning and it keeps going, waiting longer each time; a refusal (signed out) ends it. One holder per project/coordinator and machine: a second plain watch waits locally and replays its result and exit code (JSON waiters wrap plain results in JSON); if the holder dies without a result, a waiter takes over. `watch --stop` ends the holder and waiters. Under `CLAUDECODE`, the default bound is 100 minutes; a shorter external lifetime teaches a 90% bound (rounded down, minimum five minutes). `--for <minutes>` overrides it. Plain timeouts print the restart command and re-arm line on stdout. Keep the watch in a tracked background command, never `&` inside a foreground command or hidden output. Its state (a private completion receipt, a lock, the entries shown, the tickets in flight at the last read, the checkout it ran in) lives in `~/.config/armada/watch/`, no secret.
- The last line of `inbox`, `watch`, `merge` and `brief` (not `brief --prompt`) says whether to start watching again, for example `2 workers in flight (ABC-1, ABC-2) — keep watching: armada watch`; with `--json`, the same is the `watch` field.
- `armada hook session-start` restores a Claude coordinator's context after compact or resume: project, checkout, tickets with phase/age, PRs, holds, up to 20 actionable inbox lines, watch and Stop-hook banners, and the next command. The brief is capped at 60 lines. Live reads share a 15-second deadline; timeout/refusal falls back to local tickets, read time and jobs with `armada status --mine` and `armada inbox --mine`. It records presence and shown keys, never starts a watch, always exits 0, and is silent for workers, unrelated folders and fresh startup. `armada init`/`--merge` add Stop and SessionStart once in repository settings; one question accepts both and `--no-stop-hook` skips both. Doctor reports a missing SessionStart hook. For sessions starting elsewhere, add SessionStart at user level with matcher `compact|resume`, command `armada hook session-start 2>/dev/null || true`, timeout 30, alongside Stop. A new resumed id outside the coordinating checkout gets no brief.
- `armada hook stop` is the Claude Code Stop hook `armada init` adds to `.claude/settings.json` (it asks for both hooks; `--no-stop-hook` leaves both out). It identifies coordinator sessions registered by `inbox`, `watch`, `brief`, `launch` and `merge`, across checkouts; unknown sessions fall back to the coordinator checkout. Workers (`ARMADA_TICKET`) never register or get held. If any registered project has workers or jobs in flight and no watch, the reason names its checkout and asks for a background watch there. It reads local files only; read errors or a watch refusal let the turn end. Claude-only banners on watch, inbox, status, merge, launch and doctor say whether it last ran, is installed awaiting confirmation, or is off with a fix. When a session starts outside the checkout, add the Stop command `armada hook stop 2>/dev/null || true` to `~/.claude/settings.json`; init never changes user settings. Project `.claude/settings.local.json` is detected too. `ARMADA_STOP_HOOK=off` opts out.
- The Claude Code Stop hook also reminds a coordinator once per rule per session about foreground Bash commands over 60 seconds, raw `gh pr merge`, hidden Armada output (`grep`/`tail`/`head`, `/dev/null`, `2>&1 | …`, `|| true`), and its own `git commit`/`gh pr create`. It reads a bounded local transcript tail, joins the reminder with any missing-watch reason, and names the job/background, merge-finish/deploy or worker commands to use. Workers and unknown sessions in other checkouts are excluded. `ARMADA_STOP_HOOK=off` disables both guards. See [coordinator guardrails](skills/armada-coordinator/REFERENCE.md#coordinator-guardrails); manual merges end with `armada merge --finish <n>` and `armada deploy watch --sha <sha> --target <name>` in the background for each declared target.
- A coordinator's own claim is never listed as silent in its inbox: only an exact, nonempty handle match is excluded, not its questions, requests or hand-backs. `inbox` takes the reading coordinator's handle from `ARMADA_COORDINATOR_HANDLE` first, otherwise from both `CONDUCTOR_WORKSPACE_ID` and `CONDUCTOR_SESSION_ID` joined as `workspace/session`. Blank values are ignored; with no complete identity, silence detection is unchanged. Local coordinators should set `ARMADA_COORDINATOR_HANDLE` to the handle used for their claim. The same identity is used for every `--wait` poll and the dashboard presence record; the fleet-wide `status` and dashboard silence rules are unchanged.
- `answer` delivers herdr answers into the verified pane before recording them; for other runtimes, deliver first with the runtime guide's message section. A live herdr approval or question can be answered by ticket even before a worker reports. It posts `Agent status: <current phase> — answer: …` on the ticket and resolves the item. An item id needs Armada; a ticket id answers that ticket's open questions and plans and also works without it. `--note` records a delivered note as `Agent status: <phase> — note: …`; it accepts a ticket or plan item id and resolves open plans, not questions. These two are the coordinator's records: Armada never reads them as the worker's phase, hand-back or sign of life. Questions, plans and requests can be answered; `merge` resolves hand-backs, and `release` and `merge` resolve the ticket's open questions. For older clients without heartbeats, no report within `policy.silence_minutes` of an answer shows as silent. With heartbeats, the report reminder uses `policy.quiet_minutes` instead.
- The dashboard adds two kinds of request, signed by the person who made them. On a session's page or the overview's preview pane, **Approve** opens an editable approval (`approved` by default); sending it creates an `answer-request`, just like answering a question. Deliver its text, then `armada answer <request id> "<answer>"`, which resolves the request and its question or plan and names the requester on the ticket (answering the item itself also closes a waiting request). A `launch-request` asks to launch a ready ticket on a profile: launch it as usual; the worker's `armada claim` resolves it and posts who asked. To decline one, `armada answer <request id> "<why>"`: it is closed with the reason and nothing is posted on the ticket.

Plain watch reminds about unanswered action items after `[policy] coordinator_minutes` (10 by default), then doubled intervals: 10, 30 and 70 minutes from the first show. Later inbox listings do not postpone `still waiting since HH:MM`. Setting `coordinator_minutes = 0` disables reminders. Other coordinators’ items and hand-backs already in the merge queue never remind.

For a notice you deliberately leave alone, `armada ack <#id or key> --reason "<why>"` records why in Armada and posts it on the ticket as a phase-preserving note. It accepts queue refusals, deploy/job notices, `unblocked`, `silent`, `quiet`, `stopped`, `not-started`, `job-silent` and `queue-stalled`. Derived entries print their keys. The entry disappears until its key changes, such as a higher silence level or another blocker. Questions, plans, hand-backs, owner requests, approval prompts and merge holds require their resolving command. Ticketless notices are recorded in Armada only. If Linear fails, the command prints the note to post yourself; creation is not retried. Deploy the API and migration before this CLI.

## What the owner validates

The owner decides only what they asked to: a merge their rule keeps for them, the work of a kind of ticket they want to see first (a design), and a question the coordinator escalates. Each is one item on the dashboard's **Validations** page, opened from one link, `https://<dashboard>/approve/<id>`, readable on a phone, and the first thing on the page of the session it concerns. The overview lists those sessions under "Waiting for your decision" and the menu counts them; the workers' questions, plans and hand-backs stay with the coordinator.

```sh
armada merge 34 --reason "CLI only"                                         # coordinator: the rule lets it merge on its own
armada merge 34 --ask-owner --reason "touches components/timeline"          # coordinator: the owner approves it first
armada validate "Two directions for the card" --attach a.png b.png          # worker: show the owner, then stop
armada validate ABC-12 "Check the empty state" --attach https://preview.example.test   # coordinator, any ticket
armada ask-owner ABC-12 "Ship behind a flag first?" --choices "Behind a flag | On for everyone"
armada done ABC-12                                                          # coordinator: a design the owner approved
armada brief ABC-12 --validation none                                       # judge [[policy.validation]] at launch
armada brief ABC-12 --validation 1 --validation-reason "a mockup of the card"
```

- `[policy] merge_approval = "<plain words>"` says which merges the owner approves first. Absent, the coordinator merges everything on its own. Present, `armada merge` prints the rule and refuses until the coordinator judges the pull request: `--reason` merges on its own; `--ask-owner --reason` merges nothing, records the pull request (title, files with +/−, CI, the preview deployment of its head: a GitHub deployment, else a green Vercel status) with the ticket's screenshots, posts the approval link on the ticket and prints it. Armada never classifies a pull request: the coordinator judges, Armada records and enforces.
- A pull request the owner was asked about merges only once they approved that exact head; that head with only the base merged in still counts. A new head needs `--ask-owner` again. The merged comment and the dashboard say how it was decided: `merged on its own (rule: …): <reason>`, `merged on its own (no merge rule)` or `approved by <owner> at <time>`.
- `[[policy.validation]]` entries name kinds of tickets (`when`) and what their worker shows and waits for (`then`). With entries, every `armada brief` needs the coordinator's judgement: `--validation none` (no reason needed), or the rule numbers with `--validation-reason`; the refusal prints the command to copy. A rule that applies puts one block in the prompt ("This ticket needs the owner's validation: …") and its judgement in the claim.
- `armada validate` uploads the attachments (as `armada attach` does) and puts the validation on the owner's page. From a worker, for its own ticket: its phase becomes `awaiting-validation` (the label is created on first use) with the link in its status, and it stops. A newer submission replaces the open one. The owner's buttons are Approve and Request changes (with a short text), or the `--choices` given.
- The owner's decision lands in the coordinator's inbox as a `decision` item, which wakes `armada watch`: the coordinator merges, relays the changes or the choice to the worker, then `armada answer <item> "<what it did>"`. `armada done <ticket>` closes a ticket whose newest validation the owner approved, with no pull request: the design (what was checked, the owner's note, the attachment links) is posted on it, it moves to Done, and its session ends. Building it is a separate ticket.
- The dashboard's "Request the merge" button is gone: a hand-back is the coordinator's to merge.

## Merge a finished pull request (coordinator)

```sh
armada merge 34 --dry-run   # the checklist only
armada merge 34             # or the pull request URL; --ticket ABC-12 when the branch names no ticket
armada merge 34 --wait      # run in the background; main moved: update the branch on GitHub, wait for its checks, then merge
armada merge 35 --no-ticket # a pull request no ticket owns: armada init's, a release
```

- The checklist names every failure and exits 1: the ticket carries `ready-to-merge` and its newest `Agent status: ready-to-merge — PR #34, head <sha>` comment names this pull request with the full 40-character SHA of its current head; the pull request is open, not a draft, titled in Commitizen format and `CLEAN` for GitHub; every `[gates] required_checks` check is green on the head; no review thread is unresolved.
- A head that lacks commits of its base branch is refused, unless `[gates] local_commands` is set: then the head is merged into the base in a throwaway `git worktree`, the commands run there, and the worktree is removed.
- `--wait [--timeout <min>]` (30 minutes by default) keeps going until the pull request merges or a real refusal. A head behind its base that GitHub says merges cleanly is updated with GitHub's "update branch" (a merge commit, no force-push), and every required check is waited for on the new head; when the base does not require heads up to date and `[gates] local_commands` is set, it is test-merged instead. A red check, a conflict, any other refused rule, or GitHub refusing the update (a protected branch) or not applying it within 3 minutes stops it and says which. The merge lock is held only while merging, never while waiting; signed in with Armada down, it refuses before touching the branch.
- A head that is the handed-back SHA followed only by merge commits of the base still counts as the hand-back: each merge commit's first parent is the commit before it, its second parent is on the base branch, and its tree is the clean merge of the two (`git merge-tree`). The merged comment then names both heads (`head <new>, the handed-back <old> updated with main`).
- `armada ci why <pr>` (or `--sha <sha>` / `--branch <branch>`) shows the failed step, failing tests and error excerpt. Unknown tests include up to three pasteable `[[ci.known_failure]]` blocks with patterns anchored to the exact name. A test must pass on a rerun of the same head before you declare it flaky; open a root-cause ticket and replace the invalid `<root-cause ticket>` placeholder. With no test name, use the error lines to write a specific pattern. `--json` includes the drafts. `--rerun` retains the one-rerun limit and refuses unknown failures.
- `--no-ticket` merges a pull request no ticket owns (`armada init` prints the command for its own): no hand-back, nothing written to Linear, every other check unchanged, pinned to the head it checked. A branch that names a ticket of the program is refused unless you add `--reason "<why the ticket stays open>"`: the reason is posted on the PR before merging, and its ticket and worker stay unchanged. These overrides require the configured CI checks; they do not use the release exception below. When none of the required checks ran on the head (a release pull request opened with the workflow's token), it passes with a note once the head is a minute old (never a head this run updated), `UNSTABLE` included when nothing failed.
- GitHub's `HAS_HOOKS` (mergeable, with pre-receive hooks) counts as `CLEAN`.
- Hints, never blocking: top-level functions, classes, types and constants the pull request removes or renames that the base branch still uses in files the pull request does not touch.
- One merge at a time per project: a `merge` lease taken through Armada (20 minutes, renewed before the merge, atomic on its database and timed by its clock) makes a second coordinator wait. When the terminal is signed in but Armada is unreachable the merge is refused; `--no-lock` forces it, with a warning and "merged without lock" in the ticket's merged comment. Not signed in at all (one coordinator) the merge runs unlocked with a warning.
- The merge is `gh pr merge <n> --squash --match-head-commit <sha>`, never `--delete-branch` (it removes local worktrees that have the branch checked out). A GitHub 5xx is retried with backoff, each time after checking that the pull request is still open at the same head. Success is reported only once GitHub shows the pull request as merged at that head.
- Then the ticket moves to Done with its agent labels and `[tracker] ready_label` removed (unrelated labels stay), the pull request is linked, `Agent status: merged — …` is posted, the hand-back in the coordinator's inbox is resolved and the runtime handle released. The output lists the workers in flight to tell and the worker session to archive with its runtime guide, when one is installed for that runtime in `.agents/skills` or `.claude/skills`; otherwise it says there is none, since a local session or subagent has nothing to archive.
- It runs `gh` and `git` in the repository checkout and needs `LINEAR_API_KEY` and a GitHub token.

## Watch the fleet (dashboard)

`packages/dashboard` is a Next.js app whose main page is the Fleet of the projects registered in its database. With accounts, each person sees the projects of their organization; under the shared password, every project.

- **The overview** says first how many agents are blocked and how many wait for your decision, then shows a card per project (progress, blocked, for you, in flight, its coordinator active or idle).
- **One list** holds every session in flight and every ticket merged today, grouped by state (blocked, waiting for your decision, in progress, ready to merge, merged today) or by project. Each row says why it is in its state (an unanswered question, a red CI, a plan or a merge to approve, a silence…) and where it is from plan to merge. A filter shows one project.
- **List + preview** shows the selected session beside the list: its state and what to do about it, its step, pull request, CI and last reports.
- **A session's page** shows its state and what to do about it, its six steps, its reports and facts, and its pull request's files. **A project's page** shows its sessions by state, the tickets ready to launch, its open pull requests and its coordinator. **Validations** lists what waits for the owner beside the one selected; **Activity** is every event, newest first, with a line at your last visit; **Insights** is the last seven days of every project.
- **Answer** a question, approve a plan or decide a merge from the preview pane or the session's page. A project's **Ready to launch** lists the frontier with a Launch button (the routed profile in its tooltip, else the coordinator's choice). Neither reaches a worker: each becomes a request in that project's coordinator inbox, signed with the signed-in person's name and address (with accounts) or with the name the viewer gives (under the shared password; remembered in a cookie, default `ARMADA_DASHBOARD_AUTHOR`), and shows as pending until the coordinator carries it out. The dashboard holds no runtime credential.
- It stays live without a reload, and no page waits for Linear or GitHub. Each project's last reading of Linear and GitHub is kept in the app's Postgres database, and every page and poll reads only that database: the reading, plus the fleet's live data (events, claims, inboxes, coordinator activity), so a recorded report shows within seconds. A reading older than a minute (ten minutes for a project both [webhooks](#webhooks) reached within the last day) is served as is and refreshed in the background, reading only what changed in Linear since and the pull requests; Linear is read whole every 30 minutes at most, and only while someone looks. The top bar says how old the oldest reading on the page is, so a stale view never passes for a live one. A new project shows "reading Linear and GitHub for the first time" for a few seconds.
- The page polls every 5 s while work is in flight (a worker, a request waiting for the coordinator, a first reading), every 30 s when the fleet is quiet, and not at all while its tab is hidden. The server answers 304 while nothing changed. Answer, Approve and Launch show as sent on the click; a refusal puts the form back with the reason.
- When that database is unreachable, a banner says so and the view falls back to the last readings the server holds, refreshed from Linear and GitHub.
- The interface is in English or French (`ARMADA_DASHBOARD_LANGUAGE`, or the EN/FR switch).

**Owner notifications.** With accounts and `ARMADA_SECRETS_KEY`, an owner or admin opens Organization > Notifications, saves a public HTTPS webhook and clicks **Send a test**. V1 has one channel per organization, optionally filtered to a project. Slack format posts `{"text":"…"}` to Slack-compatible receivers (including Discord's `/slack` URL); JSON posts `{schema:1,kind:"alert",organization,items:[{key,kind,project,ticket,title,url}],text}` and signs the exact body with `x-armada-signature: sha256=<HMAC-SHA256>`. For JSON, enter a signing secret of at least 16 characters that your receiver also knows. The address and signing secret are sealed in the vault, write-only and never released to terminals. Only titles and links are sent.

Alerts use the same owner items as browser notifications: work or merges to validate, escalated questions, and stopped coordinators with items waiting, checked separately by name. Active coordinators also trigger one alert per plan, question, hand-back, decision or owner request left unanswered for 3 × `[policy] coordinator_minutes` (30 minutes by default). Queued or paused merges are excluded. Ticks run after fleet traffic, dashboard polls and GitHub/Linear webhook refreshes, throttled to once per minute per project, and read stored snapshots only. The outbox deduplicates across instances and claims retries too; a failed item gets at most five attempts. Ten consecutive failures pause the channel, as do HTTP 404/410 immediately; saving resumes it. Quiet-hour arrivals are retained for the next summary rather than posted as delayed alerts.

Chat alerts also announce a finished spec with its Linear link, a merge pause still open after five minutes with its reason and project link, and the clearing of a recorded pause. Existing closures and pauses are excluded when a channel is first saved. These milestones follow the channel’s alerts toggle and quiet hours; browser notifications keep their existing scope.

Digests default to 09:00, 13:00 and 18:00 on weekdays in the channel’s IANA time zone. Edit times/days or leave times empty to disable them; **Skip quiet digests** suppresses empty summaries. Each channel gets one durable local slot, even with several coordinators or app instances. A slot more than 30 minutes late is skipped and mentioned in the next digest. Digests cover merges with titles, blocked/silent durations, owner decisions with links and running phases. Remaining time is qualified as “usually”, from phase medians with at least three merged samples. Summaries also list recent deploy target states and persistent deploy failures, plus running and recently ended long jobs with their reported progress, estimated ends and app links. Merged, waiting and in-progress tickets are grouped by spec with leaf-ticket done/total counts when several groups appear; ungrouped tickets appear under Other. A single group keeps the flat layout. Available main health adds a section.

`armada status` reminds the coordinator once per 24 hours per project on each machine to use `armada digest` or `armada digest --send`. After a successful merge without deploy targets, `armada merge` similarly names `[[deploy.target]]` with a smoke command and `armada doctor`. Hints are reserved before printing in the machine's `notices.json` (legacy release receipts are preserved); unreadable memory suppresses hints. JSON and worker sessions show none. Status also names tickets held by another coordinator silent beyond twice `[policy] silence_minutes`, with the exact takeover command; transferring them removes the line.

`armada digest` prints the current project since the previous digest (channel creation for the first, or four hours without a channel). `--since 4h` or an ISO timestamp overrides the window; `--lang en|fr` overrides `[tracker] language`; `--json` includes structured data; `--send` posts through the server-side channel without exposing its address. Worker sessions cannot read or send digests. Printed and sent summaries share their builder and renderer. Quiet periods send one line by default.

**Optional scheduler, off by default.** `GET /api/cron/owner` requires `Authorization: Bearer <CRON_SECRET>`. Production ships with no enabled `crons` entry. Without a scheduler, a coordinator that stops with no worker in flight is noticed on the next fleet call, dashboard poll or GitHub/Linear webhook refresh. To enable Vercel Cron deliberately, set `CRON_SECRET` in the deployment and add `"crons": [{"path":"/api/cron/owner","schedule":"*/15 * * * *"}]` to `packages/dashboard/vercel.json`, then redeploy. Every 15 minutes requires a paid plan; the free plan allows a daily schedule such as `"0 9 * * *"`. The endpoint never refreshes Linear or GitHub and does nothing under the shared-password gate.

Try it locally with synthetic data and no key:

```sh
cd packages/dashboard
bun run demo:seed                     # a local PGlite database (Postgres in the process) with the mockup's Acme world (three projects, eleven sessions, and validations for the owner)
# bun run demo:seed busy               # the same with twenty more sessions reporting every 2 minutes all day (then ARMADA_DASHBOARD_DEMO=busy)
ARMADA_DASHBOARD_PASSWORD=off ARMADA_DASHBOARD_DEMO=fleet ARMADA_DATABASE_URL=pglite:.demo/armada bun run dev   # http://localhost:4822
```

A PGlite database belongs to one process: stop the dashboard before `bun run demo:report WID-12 shipping "Opened the pull request"` and start it again to see the row change, or point both at a Postgres database (the dashboard's `ARMADA_DATABASE_URL` and the script's `ARMADA_DEMO_DATABASE_URL`; the script never writes to the database `ARMADA_DATABASE_URL` or `DATABASE_URL` name).

The same with accounts (email and password work in development only; confirmation links are printed in the server log):

```sh
ARMADA_DASHBOARD_DEMO=fleet ARMADA_DATABASE_URL=pglite:.demo/armada ARMADA_AUTH_SECRET="$(openssl rand -base64 32)" \
ARMADA_AUTH_URL=http://localhost:4822 ARMADA_AUTH_OWNER_EMAILS=you@example.com bun run dev
```

**Deploy on Vercel.** Create a project from this repository and set these options:

- Root Directory: `packages/dashboard`, with files outside the root directory included (the default). The framework preset is Next.js, and Bun installs the workspace from `bun.lock`.
- Functions run in the region `packages/dashboard/vercel.json` names (`fra1`, Frankfurt): keep them next to the database, or change it to your database's region. Every poll makes a few database round trips, so the distance between the two is what the dashboard's speed depends on.
- The database: one Postgres database holds everything (accounts, organizations, the vault, the workers, the fleet's live data). [Neon](https://neon.com) works well: create a project in the region of the functions (`aws-eu-central-1` for `fra1`) and set its pooled connection string as `ARMADA_DATABASE_URL` (`DATABASE_URL`, which Neon's Vercel integration sets, is read too). A remote database is reached over verified TLS unless its URL says otherwise: a Postgres without TLS on a private network needs `?sslmode=disable`. The schema is applied on first use; `ARMADA_DATABASE_URL=<direct URL> bun run db migrate` (in `packages/dashboard`) applies it beforehand. Accounts are Better Auth run by the app on that database, not Neon's managed auth, which offers neither the device sign-in of `armada login` nor organization API keys, nor a way to keep sign-up by invitation only.
- Environment variables: `ARMADA_DATABASE_URL`, the accounts variables below (or, until they are set, `ARMADA_DASHBOARD_PASSWORD`), the [GitHub App](#github-app)'s `ARMADA_GITHUB_APP_ID` and `ARMADA_GITHUB_APP_PRIVATE_KEY`, and `LINEAR_API_KEY`. With accounts and the vault (`ARMADA_SECRETS_KEY`, see [Keys kept in Armada](#keys-kept-in-armada)), `LINEAR_API_KEY` moves to the Keys page and is only a fallback here, for the deployment's first organization. `GITHUB_TOKEN` is read only without the GitHub App, or for a repository it cannot read. Optional: `ARMADA_REPOSITORIES` (the `owner/name` list shown while the database is unreachable on a fresh server), `ARMADA_DASHBOARD_LANGUAGE` (`en` or `fr`), `ARMADA_LINEAR_WEBHOOK_SECRET` and `ARMADA_GITHUB_WEBHOOK_SECRET` (the [webhooks](#webhooks)), `ARMADA_DASHBOARD_SNAPSHOT_SECONDS` (how old a reading may get before a view refreshes it: default 60; a project both webhooks reached within the last day waits 10 minutes) and `ARMADA_DASHBOARD_AUTHOR` (the name requests are signed with until a viewer gives theirs). Never add a runtime token (Conductor or other): the coordinator carries out every request.
- The keys stay on the server; the browser only receives the fleet reading.

**Accounts.** People sign in with GitHub (or email and password where enabled) and belong to organizations, with the roles owner, admin and member. Accounts, sessions, organizations and invitations live in the app's database (`ARMADA_DATABASE_URL`), with the fleet's data; its schema is applied on first use. Accounts turn on only when every required variable below is set. With none of them set, the shared password applies, unchanged; with some but not all, the dashboard fails closed (503, naming the missing ones) rather than fall back to a password that shows every organization's projects.

| Variable | What |
| --- | --- |
| `ARMADA_DATABASE_URL` | The app's Postgres database (see Deploy on Vercel above); `pglite:<directory>` locally. It alone does not turn accounts on: the shared password reads the fleet from it too |
| `ARMADA_AUTH_SECRET` | Signs sessions: 32 characters at least, for example `openssl rand -base64 32`. Changing it signs everyone out |
| `ARMADA_AUTH_URL` | The dashboard's public address, for example `https://armada.example.com`: GitHub's callback and the links in emails |
| `ARMADA_AUTH_GITHUB_CLIENT_ID`, `ARMADA_AUTH_GITHUB_CLIENT_SECRET` | The Client ID and a client secret of the deployment's [GitHub App](#github-app), whose callback URL is `<ARMADA_AUTH_URL>/api/auth/callback/github`. A GitHub OAuth app still signs people in, but cannot read GitHub for the dashboard |
| `ARMADA_AUTH_OWNER_EMAILS` | Comma-separated addresses that may create an account without an invitation and create organizations |
| `ARMADA_AUTH_EMAIL_PASSWORD` | Optional, `on` or `off`: email and password sign-in, with address confirmation. Development only for now (default on): production ignores it until an email provider is plugged in, since confirmation links would sit in the server log |

- Accounts are by invitation: an account is created only for an owner address or an address with a pending invitation. The first owner to sign in creates the organization; the projects already registered, and those the CLI registers until it signs in, join the deployment's first organization. Organizations cannot be deleted.
- An owner or admin invites by email from the Organization page (the name in the top bar). No email provider is plugged in yet: messages (invitations, address confirmations) go to the server log, and the Organization page shows each pending invitation's link to copy and send. The invited person signs in with that address and accepts.
- Sessions are HttpOnly, SameSite=Lax cookies (Secure over https) valid 30 days; a revoked session can last up to five minutes (signed cookie cache). Without its database the dashboard fails closed (503). `ARMADA_AUTH_DATABASE_URL` and `ARMADA_AUTH_DATABASE_TOKEN`, the separate accounts database of earlier versions, are no longer read: a deployment that still has them and no `ARMADA_DATABASE_URL` fails closed and names it.
- Terminals sign in too (see [Sign in from a terminal](#sign-in-from-a-terminal)): `armada login` shows a code that the person confirms on the dashboard's `/device` page, and owners create API keys for headless coordinators on the Organization page. A key is shown once, belongs to the organization, and revoking it signs out whatever uses it. The CLI calls only `/api/cli/*`; without accounts those routes refuse with the next step.

**Keys kept in Armada.** With accounts, the organization's keys can live in Armada instead of on every machine: an owner or admin enters them once on the Keys page (Organization > Keys), and every signed-in terminal receives what it needs (see [Keys](#keys)). It turns on with one more variable:

| Variable | What |
| --- | --- |
| `ARMADA_SECRETS_KEY` | The vault's master key: 32 random bytes in base64 or hex, `openssl rand -base64 32`. It stays in the deployment's environment, never in a database. Changing it makes every stored key unreadable (the Keys page asks to enter them again) |

- The Keys page holds the Linear API key, and a GitHub token for the dashboard's own reads, needed only without the [GitHub App](#github-app). Each member may add their own Linear key: their terminals use it, so the comments they post carry their name.
- Each project can keep its own keys (pick it at the top of the Keys page): a Linear key, which wins for that project over the organization's and anyone's own (a project in another Linear workspace); the dashboard and every command run for that project (`status --all` and `doctor` included) read its Linear with it. And its secrets for workers (see [Secrets for workers](#secrets-for-workers)), next to the organization's, which every project gets; a project's own wins over the organization's of the same name.
- Values are write-only: once saved, a secret is never shown again, only who set it and when. Each value is sealed with AES-256-GCM under its own data key, itself sealed by the master key, and bound to its organization, project, person and name.
- A signed-in terminal (a session of `armada login`, an organization API key, or a worker session) calls `POST /api/cli/credentials`. It receives the Linear key (the person's own first), so workers and coordinators can search and edit Linear freely. Answers are never cached; a terminal asking more than 30 times a minute is refused for a minute.
- No terminal ever receives a database key. Every read and write of the fleet's live data (claims, reports, questions and plans, the inbox, answers, the merge lock, the project registry) goes through `POST /api/cli/fleet/<operation>` with the terminal's sign-in. Armada checks each one: the project must belong to the caller's organization (a project is registered for the first organization that names it), and a worker session only claims, reports, asks and releases its own ticket. Times are Armada's.
- Every change and every key handed out is in the audit list at the bottom of the Keys page (owners and admins): who, which key, when, for which project; never a value. A project picked at the top shows only its own.
- The dashboard reads each organization's fleet with that organization's Linear and GitHub keys from the vault. Only the deployment's first organization falls back to the environment's (and to `ARMADA_REPOSITORIES`): another organization could name any repository in the registry. Once the keys are on the Keys page, the environment shrinks to `ARMADA_DATABASE_URL`, the accounts variables, `ARMADA_SECRETS_KEY` and the GitHub App's. With the [GitHub App](#github-app), GitHub is read through it rather than with a stored token.
- Without `ARMADA_SECRETS_KEY` (or under the shared password), nothing changes: the Keys page says how to turn the vault on, the CLI's call answers 503 with that next step, and terminals keep their own keys.

**Switch from the shared password to accounts** (a deployment that runs on `ARMADA_DASHBOARD_PASSWORD` keeps working until the redeploy of step 4; set every variable before it, since a partial set locks the dashboard):

1. Create the database and set `ARMADA_DATABASE_URL` (see Deploy on Vercel above).
2. Create the [GitHub App](#github-app) with the callback URL `https://<your dashboard>/api/auth/callback/github`, and set `ARMADA_AUTH_GITHUB_CLIENT_ID`, `ARMADA_AUTH_GITHUB_CLIENT_SECRET`, `ARMADA_GITHUB_APP_ID` and `ARMADA_GITHUB_APP_PRIVATE_KEY`.
3. Set `ARMADA_AUTH_SECRET`, `ARMADA_AUTH_URL` and `ARMADA_AUTH_OWNER_EMAILS` (at least the address of your GitHub account), for Production and Preview.
4. Redeploy. The dashboard now asks for an account; sign in with GitHub, create the organization (the registered projects join it) and invite the others.
5. Remove `ARMADA_DASHBOARD_PASSWORD` and `ARMADA_DASHBOARD_AUTHOR`: with accounts they are no longer read.

**Password (until accounts are configured).** The dashboard asks for `ARMADA_DASHBOARD_PASSWORD` before it shows anything, on every host, a custom domain included. Every page, the polling route and every server action answer 401 or send the viewer to the login page until then; only the build's static files are public.

- Use a long random value, for example `openssl rand -base64 24`, and set it for the Production and Preview environments. It stays on the server: never prefix it with `NEXT_PUBLIC_`.
- A correct password sets a signed session cookie (HttpOnly, Secure, SameSite=Lax) for 30 days. The signature is derived from the password, so changing it and redeploying logs every browser out. "Log out" in the top bar ends one session.
- Five wrong passwords from one address block it for 15 minutes, counted per server instance.
- Without the variable and without accounts, the dashboard fails closed: every route answers 503 and names the variable. `ARMADA_DASHBOARD_PASSWORD=off` turns the password off for local development only; a production server refuses it the same way.
- Vercel Authentication (Settings > Deployment Protection) is a useful second layer, but its standard protection leaves the production custom domain open (covering it takes a paid option), so it cannot replace the password.

One deployment covers one Linear workspace: its Linear key must read every registered project. GitHub accounts are as many as the app is installed on.

### GitHub App

People sign in with GitHub, and the dashboard reads GitHub (pull requests, their CI checks, `armada.toml`), through one GitHub App of the deployment, installed with read-only rights on the GitHub accounts that hold the projects. Nobody sets a GitHub token by hand, and the CI of private repositories shows: an installation token holds the Checks permission, which fine-grained personal tokens do not have.

Create the app once, under the GitHub organization that owns the projects (its Settings > Developer settings > GitHub Apps > New GitHub App) or under your account:

| Setting | Value |
| --- | --- |
| Homepage URL | the dashboard's address, `ARMADA_AUTH_URL` |
| Callback URL | `<ARMADA_AUTH_URL>/api/auth/callback/github`, for example `https://armada.thevibecompany.co/api/auth/callback/github` |
| Expire user authorization tokens | on (the default): Armada refreshes them |
| Request user authorization (OAuth) during installation | off |
| Setup URL | `<ARMADA_AUTH_URL>/organization/github`, with Redirect on update: GitHub sends whoever clicks Install on GitHub in Armada back to the page, which links the installation in the same step |
| Webhook | Active, URL `<ARMADA_AUTH_URL>/api/webhooks/github`, secret the value of `ARMADA_GITHUB_WEBHOOK_SECRET` (see [Webhooks](#webhooks)); subscribe to Pull request, Check suite, Check run and Status |
| Repository permissions | all **Read-only**: Actions, Checks, Commit statuses, Contents, Metadata, Pull requests. Nothing else, and no write access |
| Account permissions | Email addresses: **Read-only** (sign-in reads the verified address) |
| Where can this GitHub App be installed? | Only on this account; Any account if the projects live under several GitHub accounts |

Then:

1. On the app's page, note its App ID and Client ID, generate a client secret, and generate a private key (a `.pem` file is downloaded).
2. Set the variables below for Production and Preview, and redeploy.
3. Install the app (the app's page > Install App) on each GitHub account that holds a project, for all repositories or only the projects'.
4. Open Organization > GitHub: it names the app and its installations. The deployment's first organization reads through every installation at once; another organization's owner or admin clicks Install on GitHub there, or links an installation made outside Armada (see below).
5. Once the Fleet view shows the pull requests and CI of every project, delete the GitHub token from the Keys page and `GITHUB_TOKEN` from the deployment.

| Variable | What |
| --- | --- |
| `ARMADA_GITHUB_APP_ID` | The app's App ID (a number) |
| `ARMADA_GITHUB_APP_PRIVATE_KEY` | The whole `.pem` file, `-----BEGIN RSA PRIVATE KEY-----` included. On one line, `\n` stands for each line break |
| `ARMADA_AUTH_GITHUB_CLIENT_ID`, `ARMADA_AUTH_GITHUB_CLIENT_SECRET` | The app's Client ID and client secret, for sign-in (see Accounts above) |

- The dashboard signs a JSON Web Token with the private key, asks GitHub which installation covers each project's repository, and mints that installation's token on the server. A token lasts an hour and is reused until five minutes before it expires; it never reaches a browser or a terminal. The private key stays in the deployment's environment.
- Which installations an organization reads through: the deployment's first organization (and every project under the shared password), any of the app's, as with the environment's keys; any other organization, only those linked to it. On Organization > GitHub, an owner or admin clicks Install on GitHub: GitHub's install page opens with a signed state naming the organization and the person, valid 30 minutes and once, in the browser that clicked; when GitHub sends them back to the Setup URL the installation is linked, with no other click. The page also lists the installations GitHub lets them reach, each with a Link button, for those made outside Armada. Either way, Armada asks GitHub with the person's own sign-in, so nobody links an installation they cannot see on GitHub; a forged, expired or someone else's state links nothing, and coming back after changing the repositories keeps the link. Links and unlinks are in the Keys page's audit list. Otherwise one organization could register another's repository and read it through the app.
- People who signed in through an earlier OAuth app sign out and in again once, so Armada holds a token of the app that can list their installations. The GitHub tokens of sign-in are stored sealed with `ARMADA_AUTH_SECRET`.
- Without `ARMADA_GITHUB_APP_ID` and `ARMADA_GITHUB_APP_PRIVATE_KEY`, nothing changes: the dashboard reads GitHub with the Keys page's GitHub token or `GITHUB_TOKEN`. With the app, that token is only the fallback for a repository the app cannot read, and the Fleet view says why the app could not (not installed there, or not linked).
- Terminals do not change: `armada` reads GitHub with `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token`, and the coordinator merges with its own `gh`.

## Webhooks

Two webhooks bring a change in Linear or on a pull request to the dashboard within seconds; without them, a reading is refreshed when someone looks and it is older than a minute.

| Variable | What |
| --- | --- |
| `ARMADA_LINEAR_WEBHOOK_SECRET` | The signing secret Linear shows for the webhook below |
| `ARMADA_GITHUB_WEBHOOK_SECRET` | A random secret (`openssl rand -hex 32`), also pasted in the GitHub App's webhook settings |

1. **Linear:** Settings > API > Webhooks > New webhook, URL `<ARMADA_AUTH_URL>/api/webhooks/linear`, data change events Issues, Comments, Issue attachments and Issue labels, for all public teams (or the program's teams). Copy its signing secret into `ARMADA_LINEAR_WEBHOOK_SECRET`.
2. **GitHub:** on the [GitHub App](#github-app)'s settings, turn the webhook on with the URL `<ARMADA_AUTH_URL>/api/webhooks/github` and the secret of `ARMADA_GITHUB_WEBHOOK_SECRET`; under Permissions & events > Subscribe to events, tick Pull request, Check suite, Check run and Status.
3. Set both variables for Production (and Preview if it has its own database), and redeploy.

- Each delivery is checked (Linear's `Linear-Signature` and a timestamp within a minute; GitHub's `X-Hub-Signature-256`), marks the projects it concerns in one statement, and is answered at once; the refresh runs after the answer. A delivery only says which projects to read again: nothing in it is stored or shown, and the reading always comes from Linear and GitHub with the project's own keys.
- A Linear delivery concerns the projects whose reading holds its ticket (or the ticket's parent, for a new ticket); a GitHub delivery, the projects of its repository. A burst of deliveries (a CI run) makes one read every 10 s at most, not one each; a mark left by the burst waits for the next view or delivery, and stays until a reading that saw it is written, even if a refresh fails or is cut short. A label renamed in Linear asks every project for a whole read on its next view.
- Until a variable is set, its webhook answers 503 and the dashboard refreshes on view as before.

## Sign in from a terminal

The CLI knows who is acting, and for which organization, by signing in to Armada, the way `gh auth login` does:

```sh
armada login     # shows a one-time code, opens the confirmation page; you approve it in the browser
armada whoami    # the person (or API key) and the organization; --json for scripts
armada logout    # revokes this terminal's session and removes it from the machine
```

- A coordinator without a browser (a cloud workspace, CI) uses an organization API key instead: an owner creates it on the Organization page (it is shown once), and the coordinator sets `ARMADA_API_KEY`, or stores it with `armada login --api-key` (hidden prompt, or standard input: `printf %s "$KEY" | armada login --api-key`; never on the command line). `ARMADA_API_KEY` in the environment wins over what `armada login` stored. Revoking the key signs the coordinator out.
- The session token or key is kept in the credentials file below (mode 0600) and never printed; `armada auth status` says how the terminal is signed in, without it. A session lasts 30 days and is renewed while in use.
- A worker signs in with the launch token of its launch message, as its first authenticated command: `armada login --launch-token <token>` (plus `--api-url <url>` for a self-hosted Armada, which the brief adds). The worker session it gets is kept per ticket in the credentials file and signs in that ticket's `claim`, `report`, `ask` and `release` only; each of them asks Armada for its keys, and stops with Armada's reason once the session is revoked (Organization > Workers) or ended (`armada release`, or the coordinator's `armada merge`). It lasts while the worker keeps reporting, up to three days idle.
- Commands that need a sign-in say so and name `armada login` as the next step; so does an expired session or a revoked key.
- The CLI talks to `https://armada.thevibecompany.co`. A self-hosted Armada is named by `ARMADA_API_URL`, or `[api] url` in `config.toml` (https; plain http only for `localhost`). A stored sign-in is sent only to the Armada that issued it: pointing the CLI at another one asks for `armada login` there.
- Until an Armada has accounts (it runs on the shared dashboard password), it refuses terminal sign-ins and says so; the keys below keep working as they do today.

## Keys

Armada needs a few keys. A terminal signed in to an Armada that keeps its organization's keys ([Keys kept in Armada](#keys-kept-in-armada)) needs none on the machine: `armada login`, then `armada status`. Otherwise set them up once per machine with `armada auth login`, or pass them as environment variables (the way to go in CI and with an Armada without accounts): a key in the environment wins over Armada's.

Each key comes from the environment first, then from Armada when signed in, then from the credentials file. Armada is asked only for what the environment does not set, on each command that needs keys, so a key replaced on the Keys page takes effect on the next command. The Linear key it gives stays in memory. When Armada cannot be reached, the command warns and goes on with the machine's keys. The fleet's live data needs no key at all: it is reached through Armada with the sign-in. Database variables of earlier versions are no longer read; `armada login`, `armada logout` and `armada auth logout` remove them from the credentials file.

| Variable | What | Needed by |
| --- | --- | --- |
| `LINEAR_API_KEY` | Linear personal API key (Linear > Settings > Security & access > Personal API keys) | `armada status` |
| `GITHUB_TOKEN` or `GH_TOKEN` | GitHub token; otherwise `gh auth token` is used | pull requests and CI |

- `armada auth login` asks only for the keys that are missing, with hidden input for tokens, and stores them in `~/.config/armada/credentials` (or `$XDG_CONFIG_HOME/armada/credentials`), mode 0600 in a 0700 directory. Without a terminal it asks nothing and lists the variables to set instead.
- `armada auth status [--json]` shows which keys are set and where each comes from (for example `Armada: your own key`). It never prints a value.
- `armada auth logout` removes Armada's keys from the file.

The credentials file is a plain dotenv file (`KEY=value` lines, `#` comments) that a shell can also `source`. You may edit it by hand; Armada keeps your other lines and comments when it updates it. GitHub tokens are not stored there: use the environment or `gh auth login`.

Non-secret personal defaults go in `config.toml` next to it, created by the first `armada auth login`:

```toml
language = "en"                  # your language (BCP 47 tag)

[dashboard]
url = "https://<your-armada-dashboard>"

[api]
url = "https://armada.example.com"   # a self-hosted Armada for `armada login`; used when ARMADA_API_URL is not set
```

### Secrets for workers

What a project's workers need to build and test (an LLM provider key, a test database URL) is kept in Armada with the project, never in a worker's launch environment. Names are in upper snake case; the keys Armada itself uses (`LINEAR_API_KEY`, `GITHUB_TOKEN`, `GH_TOKEN`, `ARMADA_*`) are not secrets for workers.

- The coordinator sets them, signed in as an owner or admin (or with an organization API key whose creator still is one): `armada secrets set <NAME>` for the current project, `--org` for every project of the organization. The value is read from a hidden prompt, from standard input (`--value-stdin`), or from a variable of the coordinator's environment (`--from-env <VAR>`), so an agent can move a key without reading it. Never from the command line. `armada secrets unset <NAME> [--org]` removes one. Owners and admins can also do both on the Keys page.
- `armada secrets` lists the names, where each is set (project or organization), who set it and when. Never a value.
- A worker fetches them through Armada, with its worker session, for its own project only (another project's is refused, and the refusal is in the audit list), in this order:
  - `armada run [--only A,B] [--redact] -- <command>` runs the command with them in its environment: tests, builds, dev servers. Armada's value wins over a variable of the same name (stderr names it). Nothing is written to disk; the exit code is the command's. Non-interactive stdout and stderr are masked, including values split across output chunks. When stdout is a TTY, output inherits the terminal and **is not masked**; Armada warns once. `--redact` forces masked pipes for an interactive command.
  - `armada secrets export --file <path> [--only A,B]` writes a dotenv file with mode 0600, for a tool that reads one (`.env.local`). It refuses a path git tracks or does not ignore.
  - `armada secrets get <NAME>` prints one value, for a person, with a warning on stderr that it is now visible. An agent never runs it: its command output is its transcript.
- Exact project secret values and the terminal's resolved credentials are replaced with `«secret OPENAI_API_KEY»` (using their name); well-known key formats and PEM private keys become `«redacted»`. Values **shorter than 8 characters are not masked**, to avoid false matches. A masking warning names only the secret or the key-pattern match. This is a safety net: never echo secrets, paste them into messages, or assume transformed/encoded values will be caught.
- Reports, plans, questions, validations, answers, attachment captions and their Linear comments are masked before sending. The server also masks stored free text against the project's secrets, protecting older clients. If the CLI cannot read project secrets, it warns and continues with resolved credentials and patterns so Linear reporting still works; arbitrary project values then lack exact masking. A server with stored secrets it cannot decrypt refuses the text write.
- Every fetch is one release in the audit list, naming the project and the secrets. Nothing is cached: an unset secret is no longer handed out, and a changed one takes effect on the next command.
- `[secrets] names` in `armada.toml` lists what the project expects; `armada doctor` names those Armada does not keep for it.

## Configure a project

Add an `armada.toml` at the root of the repository. One project is one repository plus one Linear program root. The file holds no secrets.

```toml
[project]
name = "Widgets"
slug = "widgets"                 # stable id: lowercase letters, digits, dashes

[tracker]
program_root = "ABC-1"           # Linear issue at the root of the program (required)
language = "en"                  # owner-facing language (default "en"; output is English for now)
ready_label = "ready-for-agent"  # marks a ticket an agent may take (default)
parked_label = "parked"          # marks a ticket parked on purpose: never listed as work to start (default)

[tracker.labels]
phase_group = "Agent phase"      # single-select label group for the agent phase (default)
runtime_group = "Agent runtime"  # single-select label group for the agent runtime (default)
runtimes = ["Claude Code", "Codex", "Conductor"]  # values of the runtime group (default)

[github]
repository = "acme/widgets"      # owner/name (required)

[gates]
required_checks = ["test"]       # CI checks that must be green before a hand-back or a merge (default: every check)
local_commands = ["npm ci", "npm test"]  # run by `armada merge` on a test merge of a head behind its base (default: none: the worker brings the base branch in instead)

[policy]
# max_workers = 10              # project-wide worker sessions; absent means uncapped
attachments_per_ticket = 20      # images and links together (default 20)
attachments_project_mb = 200     # private image bytes per project, MB = 1024² bytes (default 200)
attachments_retention_days = 30  # deleted after completion/cancellation by the next project refresh (default 30)
silence_minutes = 15             # no heartbeat for longer flags a worker silent (default 15; reports for older clients)
quiet_minutes = 45               # live without a report for longer adds a coordinator-only note (default 45)
coordinator_minutes = 10         # first waiting-item reminder; intervals double, 0 disables (default 10)
not_started_minutes = 10         # a launched worker that has not claimed after this long shows as not started (default 10; a CLI older than this setting refuses it)
plans = "approve"                # or "pre-approved": workers post their plan and go on (default "approve")
pre_approved_label = "plan-approved"     # a ticket with this label is pre-approved (default)
approval_label = "needs-plan-approval"   # a ticket with this label waits for approval; wins over the other (default)
merge_approval = "merge on your own, except front-end changes: send me a link to check them first"  # default: none, every merge on its own

[[policy.validation]]            # any number: kinds of tickets whose work the owner validates first
when = "a design ticket: a mockup, a visual direction or the look of a new screen"
then = "produce the design, attach it, ask the owner to validate it on Armada, and stop until they decide; never merge or build it on your own"

[brief]
extra = "docs/worker-conventions.md"     # every brief ends with this file under "Project conventions" (default: none)

[secrets]
names = ["OPENAI_API_KEY", "TEST_DATABASE_URL"]   # what workers need from Armada; `armada doctor` names those not set (names only)

[conductor]
default_profile = "opus"         # for tickets no routing rule matches (required with routing)

[conductor.profiles.opus]        # one table per profile; `conductor model` lists the ids
agent = "claude"
model = "opus-5-5-1m"
effort = "high"
# fast_mode = true               # optional, default false
# runtime = "conductor"          # or "claude-code": a subagent of a Claude Code coordinator (agent = "claude", model = "opus")

[conductor.profiles.codex]
agent = "codex"
model = "gpt-6.1-sol"
effort = "high"

[conductor.profiles.debug]
agent = "codex"
model = "gpt-6.1-sol"
effort = "xhigh"

[[conductor.routing]]            # first rule with a label the ticket carries wins, in file order
labels = ["web"]                 # any of these labels
profile = "opus"

[[conductor.routing]]
labels = ["api"]
profile = "codex"

[[conductor.routing]]
labels = ["Bug"]
profile = "debug"
```

A missing or invalid key stops the command with a message naming it, for example `missing required key "tracker.program_root"`. This repository's own configuration is in [`armada.toml`](https://github.com/The-Vibe-Company/armada/blob/main/armada.toml).

The program follows one convention: specs are direct children of the root titled `Spec N — Name` or `Spec N/M — Name`, tickets are their sub-issues, and dependencies are Linear blocked-by relations. Both title forms are always read, including in mixed programs. Agents declare their phase with a label from the phase group (`planning`, `awaiting-approval`, `implementing`, `shipping`, `blocked`, `ready-to-merge`) and start every comment with `Agent status: <phase> — <summary>`.

The coordinator creates a spec with `armada spec add "Search images"`. It appends after the largest spec number, uses the program root as parent, includes the **In short** template, inherits the root's Linear project and starts in the team's first backlog state (first to-do state if there is no backlog). It prints the project (or `no project`), state and URL; with neither state available, it keeps Linear's default. Check Linear before running the command again after a creation failure. The default `[tracker] spec_titles = "N"` keeps existing titles unchanged when appending. New project configurations write that setting; configurations without it also default to `"N"`.

To insert in the middle, run `armada spec add "Search images" --at 5`: it displays the suffix renames and creates nothing. Repeat with `--apply` to rename 5→6 and so on, then create the new Spec 5. `armada spec renumber` previews a repair of gaps and duplicates in ordinal order (creation time, then issue identifier break ties); `--apply` applies it and normalizes all titles to the configured style.

**Projects whose own rules require N/M:** set `[tracker] spec_titles = "N/M"` before using these commands. Adding then updates every total, and requires `--apply` even when appending. In default N mode, inserting preserves any legacy denominators rather than bumping them; `renumber --apply` removes them. Writes run one at a time and stop on the first failure, listing the unconfirmed renames and creation. Inspect Linear before retrying, since a timed-out write may have arrived; `renumber` can preview a repair. Worker sessions cannot run `armada spec`.

## Develop

Use the [Bun](https://bun.sh) version pinned in `package.json`'s `packageManager`
(currently 1.4.2). CI and release builds read the same pin.

```sh
bun install
bun run armada status   # run the CLI from source
bun run verify          # lint, typecheck, tests
bun run build           # CLI and dashboard production builds
```

When changing a package under `skills/`, commit only its source files. The gitignored
`packages/core/src/skills.generated.json` is generated automatically during install,
tests (including direct `bun test`), typechecks, source CLI runs and builds. Packing
and release build the CLI with the current skill text inlined for Node. Run
`bun run armada skills update` to refresh this repository's pointers and vendored
packages; `bun run skills:bundle` remains available for manual regeneration.

See [AGENTS.md](https://github.com/The-Vibe-Company/armada/blob/main/AGENTS.md) for the layout and the rules.

## What it is made of

- **`armada` CLI** (TypeScript). The coordinator and the workers call it to claim tickets, report progress, ask and answer questions, launch workers and merge.
- **Skills** delivered by `armada init`: pointers to the CLI's coordinator, worker and runtime instructions, plus vendored shipping/review/learning packages. Their complete sources live in [`skills/`](skills).
- **Linear** holds the plan: specs, tickets, dependencies and agent phases.
- **The app's database** (Postgres, e.g. Neon) holds the accounts, the organizations' sealed keys and the fleet's live data: events, heartbeats, pending questions and locks. The CLI reaches it only through the Armada API, with its sign-in. Losing it loses live detail, never progress.
- **Conductor Cloud** runs the workers in the first version. Other runtimes come later without changing the worker contract.
- **Dashboard** (Next.js, `packages/dashboard`): the live Fleet view of every project. The program view comes later.

Workers ship with the bundled `ship-pr-dev` by default. The hand-back command adds
`--shipped-with "ship-pr-dev"`, or `--shipped-with "fallback: <exact reason>"` when the
workflow cannot run. Linear and `armada inbox` show `shipped with ship-pr-dev` or
`shipped with the fallback: <reason>` with the PR and full SHA. Older workers remain
compatible and their hand-backs say `shipping path unreported`; this field records
the worker's declaration, not an independent CLI verification of review artifacts.

## License

MIT. The bundled Alibaba review workflow retains Apache-2.0; each shipping skill
includes its license and attribution notices.

Persistent local workers: `armada status`, `inbox` and `watch` publish herdr state for the dashboard. `armada stop <ticket>` archives only a clean worktree whose commits are on its verified remote upstream, retaining its branch. See [`armada-runtime-herdr`](skills/armada-runtime-herdr/SKILL.md) for all four runtime operations.

Conductor worker reads retry brief timeouts, server errors, temporary execution failures and truncated JSON up to twice, with roughly 1 s and 3 s waits and a notice on stderr. Retries add at most 14 s per read, including execution time. Sign-in, invalid-request and not-found errors fail immediately; create, message, cancel and archive writes are attempted once. See [`armada-runtime-conductor`](skills/armada-runtime-conductor/SKILL.md).

### Pause and resume merges

A coordinator can pause a project's merges with a reason. The pause is stored in Armada, shared with every coordinator, and stays until explicitly cleared. Status, watch and the inbox show it.

```sh
armada hold add "api deploy is broken"
armada hold                         # list the open holds
armada merge 42 --through-hold "repairs the broken deploy"
# Verify recovery, then resume:
armada hold clear 4 --reason "deploy smoke checks pass"
```

Normal merges refuse with each hold's reason and id. `--through-hold` lets a fix pass every open hold and records the reason with every hold id on the merged ticket; it leaves the pauses open. Clear every open hold to resume normal merges. The server also refuses a merge lease to an older CLI that does not read holds, preserving the shared pause across coordinator versions. Holds never expire, and repeated clears report who cleared the hold and when. `--wait` stops when it sees a hold. `--no-lock` skips both the merge lease and checking holds, and prints that warning.

Workers can reserve a shared number, name or exclusive resource for their ticket through Armada:

```sh
armada reserve db-migration --next --floor 22  # prints the next number, e.g. 23
armada reserve fixture --value sample --note "integration fixture"
armada reserve release                      # exclusively holds this key
armada reserve --list
armada unreserve fixture
```

The ticket defaults to `ARMADA_TICKET`, the current branch, or the one stored worker session; `--ticket <id>` overrides it. A release or `unreserve` frees a value. A merge ends the reservation and keeps its value used permanently. Number allocation starts above the highest held or merged number and `--floor` (the last number already used in the repository). Released values can be explicitly reserved again; `--next` reuses them when they are above the remaining highest number. Allocation is atomic even when workers ask together.

Declare keys in `armada.toml` to include them and their current holders in each launch brief:

```toml
[[reservations]]
key = "db-migration"
what = "the next DB_MIGRATIONS version"
numbered = true
```

Declarations are optional documentation; undeclared keys can also be reserved. Reservations require Armada: if it is unavailable, ask the coordinator before choosing a value. After a lost response, check `armada reserve --list` before retrying, since the reservation may already have succeeded.

### Live acceptance before hand-back

Declare real build or preview checks in `armada.toml`. Each worker brief lists the
commands and limits; `armada report ready-to-merge` requires a Linear pass on the
exact PR head for every applicable check.

```toml
[[acceptance]]
name = "production build"
command = "docker build -f deploy/Dockerfile ."
paths = ["deploy/**", "Dockerfile", "package.json"]
timeout_minutes = 20
max_runs = 3
```

Omit `paths` to check every PR. Patterns support `*`, `**` and `?`; paths match
GitHub's changed files. An incomplete file reading or a rename whose original
path is unavailable applies every rule. The
default timeout is 15 minutes (maximum 120) and the default cap is three runs per
check and ticket. For commands needing project secrets, use `armada run -- …`.

Bring main in, commit and push, then run `armada acceptance run` in the clean
checkout (`--name "production build"` selects one check; `--ticket <id>` selects
the ticket). HEAD must equal the linked PR head. Fix every error before handing
back. Failed, timed-out and interrupted attempts count; a changed head needs a
new pass. At the cap, ask the coordinator, who can grant more with
`armada acceptance allow <ticket> --runs 2 --reason "<why>"`. Results and run
counts live in Linear. A local per-ticket lock prevents overlapping runs on the
worker's machine, even across checkouts. Diagnostics are masked with released
project secret values; if those values cannot be read, failure output is withheld.
Live fleet reports remain optional when Armada is
down. The merge checklist shows the evidence without adding a merge refusal,
so bringing main in with `merge --wait` preserves the worker's proven hand-back.

### Check deploys after each merge

Declare optional `[[deploy.target]]` entries in `armada.toml`:

```toml
[[deploy.target]]
name = "api"
branch = "main"                    # omit for the merged PR's base branch
paths = ["cmd/**", "internal/**"]  # optional repository-relative globs
# Exactly one source of the live commit:
github_environment = "production"
# check = "./scripts/check-deploy.sh"  # exit 0 live, 1 host failure, 2 pending or skipped
# live_sha_command = "curl -fsS https://example.test/version"
smoke = "curl -fsS https://example.test/health" # optional
timeout_minutes = 20              # 1–120
pause_on_failure = true
```

`armada merge` starts a background deploy watcher and prints `Watching the deploy of <sha> to <target>`. Deployment failures, smoke failures and timeouts create one inbox item and a shared deploy hold for that target. Run `armada deploy retry <target>` to run an optional `redeploy` command once and watch a new attempt; `--no-redeploy` only rechecks after a host redeploy. A healthy observation clears the pause and resolves its inbox item with recorded evidence. Never clear a deploy hold before a healthy recheck. Deploy dashboard/API migration 46 before the new CLI. A later healthy deploy clears the failures it covers. Use `--through-hold "<why>"` to merge the repair. `pause_on_failure = false` keeps the inbox warning without pausing merges.

Choose exactly one of `github_environment`, `live_sha_command` or `check`. A `check` exits 1 only for a confirmed host deploy failure, which pauses merges on the next poll; exit 2 for pending or network errors. Exit 2 with a last stdout line `skipped: <reason>` ends as `not deployed (host skipped: …)` without smoke, a hold or an inbox item, and exits 0. Exit 0 runs smoke as usual. Legacy `live_sha_command` keeps waiting until timeout on failure. `armada doctor` warns for each target without smoke and explains the legacy source's limitations; the merge's watching line warns that a live but broken service reads healthy without smoke. Deploy dashboard/API migration 45 before updating the CLI. See the runbook below for the contract and an example adapter.

With `paths`, a merge that touches none of the globs prints one skip line and starts no watcher or deploy hold. Globs match repository-relative paths, including dot files. Missing or incomplete changed-file coverage (including renames whose original path is unknown) keeps the watcher. Omit `paths` to watch every merge on the target's branch. For an affected target, the live commit must equal the merged commit or be a verified descendant; smoke then runs as usual.

For commands that need a machine-specific linked folder, declare the setting by name:

```toml
[[deploy.target]]
name = "worker"
live_sha_command = 'cd "$DEPLOY_LINK_DIR" && hosting-cli live-sha'
requires_env = ["DEPLOY_LINK_DIR"]
```

On each coordinator machine, run `armada config set deploy.env.DEPLOY_LINK_DIR /path/to/linked-service` from the project checkout. Non-secret values are stored per project in `~/.config/armada/projects/<slug>.json` (or `$XDG_CONFIG_HOME/armada/projects/<slug>.json`), outside the repository. Machine values win over the process environment; only declared names are added to the target's live and smoke commands. Use `armada config unset deploy.env.DEPLOY_LINK_DIR` to return to the process environment. A damaged settings file produces a diagnostic and uses the process environment; `armada config set` repairs it. Keep secrets in Armada's vault and use `armada run` for commands that need them.

`armada doctor` names each target's missing settings and gives the exact `armada config set` fixes. Empty environment values count as missing. After a merge, a target missing a required setting emits one `deploy check skipped: <VAR> not set on this machine` warning and records `skipped (not configured on this machine)` without a merge hold or failure inbox item. A configured command that fails still pauses merges. After configuration, `armada deploy watch` can retry the skipped SHA. A machine-local skip preserves any real observation already recorded by another watcher for the same SHA.

`armada deploy status` shows each target's latest state and any open deploy hold; `armada status` includes deploy states. Commands run at the repository root with `ARMADA_DEPLOY_SHA` and `ARMADA_DEPLOY_TARGET`, bounded to one minute and the deploy deadline. Declare `armada run -- <command>` when a command needs project secrets. Watchers share smoke results for the same live SHA. If background startup fails, the merge prints a command to run in a persistent terminal. See the [deployment runbook](docs/runbook.md#check-deployments-after-merges) for recovery and logs.
