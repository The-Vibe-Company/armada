# Armada

Armada runs a fleet of coding agents on one project and keeps every piece of work visible.

It imposes one method: grill the decisions, write a spec, cut it into tickets, let one worker agent ship each ticket as a green pull request, and let a coordinator agent merge. The tracker is the source of truth for progress; Armada adds live telemetry, contention rules and a fleet dashboard on top.

**Status:** early. `armada status`, `armada auth`, `armada doctor`, `armada init`, `armada brief`, `armada claim`, `armada report`, `armada release`, `armada ask`, `armada inbox`, `armada answer` and `armada merge` work; the other commands are being built.

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

```sh
armada login
armada init --program-root ABC-1
armada status       # or: armada status --json
```

Workers then need no key either: each one's launch message carries a one-time token, and Armada gives it its keys ([Launch a worker](#launch-a-worker-coordinators)). Without an Armada that keeps keys (a self-hosted one without accounts, CI), set the keys in the environment or run `armada auth login` ([Keys](#keys)).

`armada status` reads the `armada.toml` of the current repository (or the nearest parent directory) and prints:

- **In flight**: tickets an agent holds, with their phase, runtime, last report and pull request. A worker with no report (an `armada report` event recorded through Armada, an `Agent status:` comment or its claim) for longer than `policy.silence_minutes` is flagged `silent`, unless it is waiting on a human (`awaiting-approval`, `blocked`, `ready-to-merge`). A ticket that never had a report falls back to its last sign of life (ticket edit, comment or pull request update).
- **Ready to start**: tickets without sub-issues that are not started, not held by an agent, have no open pull request, and whose blocked-by tickets are all closed, ranked by what they unlock. Tickets without the ready label, or still in triage, are listed separately.
- **Pull requests waiting**: open pull requests with their CI state and mergeability.

GitHub is read with `GITHUB_TOKEN`, `GH_TOKEN` or the GitHub CLI login (`gh auth token`). Without any of them the tickets are still shown.

## Set up a repository

```sh
armada doctor                          # what this repository lacks, with the fix for each
armada init --program-root ABC-1       # one pull request that adds it all
```

`armada doctor` checks, in the repository you are in:

- `armada.toml` exists and is valid;
- the Armada skills (`armada-coordinator`, `armada-worker`, `armada-runtime-conductor`) are in `.agents/skills`, linked from `.claude/skills`, recorded in `skills-lock.json` (the [`npx skills`](https://github.com/vercel-labs/skills) format), and match this version of Armada;
- `.conductor/settings.toml` has a `[scripts] setup` command;
- `.gitignore` ignores `plans/ship-pr-dev/`;
- this terminal is signed in to Armada, and to which organization: without a sign-in, `armada brief` gives workers no launch token, so each would need the keys in its environment;
- this CLI is as recent as that Armada expects (signed in only): every answer of the Armada API names the oldest CLI that reads it right and the latest one, and a CLI older than the oldest prints one line on any command, `Armada <version> is older than this server expects: npm install -g @the-vibe-company/armada@<latest>`;
- no key is left in the credentials file that Armada now gives this terminal (`armada auth logout` removes them, the sign-in stays);
- the Linear label groups `Agent phase` and `Agent runtime` exist with every value (needs a Linear key, from Armada or `LINEAR_API_KEY`);
- with `[conductor.profiles]` in `armada.toml`, the `conductor` command is found: on PATH, or inside the macOS app at `/Applications/Conductor.app/Contents/Resources/bin/conductor`, with the fix that puts it on PATH.

Each problem is an error or a warning, with its fix. A missing skill, or a CLI older than Armada expects, is an error: workers cannot run without it. A skill that differs from this Armada version, a missing ignore line, a missing sign-in or a leftover key is a warning. Doctor exits 1 when there is an error. `--json` prints the same report as JSON.

`armada init` fixes everything doctor reports in one go:

1. It creates the missing Linear labels (a missing group goes in the team of the program root).
2. It builds the missing or outdated files on a fresh checkout of the default branch, commits them on the branch `armada/init-<version>` and opens a pull request with `gh`. Your own checkout is not touched. Running it again rebuilds that branch and updates the same pull request. When the default branch already has everything, no pull request is opened.
3. It registers the project (slug, name, repository, program root) on Armada, for the organization the terminal is signed in to, so `armada status --all` and the dashboard list it. A slug another organization already holds is refused.

On a repository without `armada.toml`, pass `--program-root <ISSUE-ID>`; the name comes from the GitHub repository unless you pass `--name`, and the slug from the name unless you pass `--slug`. An existing `armada.toml` is never replaced. `init` needs `git`, the GitHub CLI logged in (`gh auth login`), a sign-in to Armada (`armada login`), and the Linear key, from Armada or from `LINEAR_API_KEY`; on a terminal it asks for a missing key first.

`armada status --all` prints the status of every project registered for the organization the terminal is signed in to, each read with the `armada.toml` on its repository's default branch. A project that cannot be read shows its error without hiding the others.

## Launch a worker (coordinators)

Armada prepares a launch; it never starts a runtime itself. The `armada-runtime-conductor` skill gives the exact Conductor Cloud commands. [`docs/runbook.md`](docs/runbook.md) says how to start a coordinator on a laptop or in Conductor Cloud, what the owner sets up once, and how one coordinator hands over to the next.

```sh
armada brief ABC-12                    # launch settings, then the worker's prompt
armada brief ABC-12 --prompt           # only the prompt, to pipe into the runtime (--message-file -)
armada brief ABC-12 --profile codex --reason "a back-end bug behind a web label" --json
```

- The prompt names the ticket and its Linear branch, starts by installing the coordinator's Armada version (`npm install -g`, with an `npm exec` fallback), signing in with `armada login --launch-token <token>` and running `armada claim` with the handle `$CONDUCTOR_WORKSPACE_ID/$CONDUCTOR_SESSION_ID`, and carries the blockers with their hand-back notes, the comments already on the ticket and the workers in flight.
- **Workers need no key.** When the coordinator is signed in to an Armada that keeps the organization's keys, the brief asks it for a launch token: one ticket, used once, valid one hour. The worker exchanges it for a session limited to its ticket's `claim`, `report`, `ask` and `release`, and Armada gives each of those commands its keys. The `Launch:` line says whether the prompt carries one, and when there is none, why (not signed in, or an Armada without accounts or keys). Only `--prompt` prints the token; the full brief and `--json` show it as `armada_launch_••••`, so it stays out of the coordinator's transcript. Make the brief right before the launch; the token is the only secret a prompt ever holds, useless once used. Merging or releasing the ticket ends the worker's session, and Organization > Workers on the dashboard revokes one.
- The settings give the profile's agent, model and effort from `[conductor]` in `armada.toml`, and the environment variables: `ARMADA_TICKET=<ticket>`, and, only without a launch token, `LINEAR_API_KEY` (required). Each shows whether this shell has it. No value is ever printed.
- The profile follows the ticket's Linear labels: the first `[[conductor.routing]]` rule with a label the ticket carries (case, spaces and punctuation ignored), else `conductor.default_profile`, else the only profile. The settings say which rule chose it.
- `--profile` overrides that choice. When `armada.toml` has routing rules and the profile differs from the routed one, `--reason` is required. The reason travels into the claim command, so the claim comment records the profile and why. An unknown profile exits 2.

## Work on a ticket (workers)

A worker writes to the tracker only through three commands. They set the labels and write the comments in the protocol format, and record each event on Armada with the worker's sign-in.

```sh
armada login --launch-token <token>        # the first line of the launch message: no key needed after it
armada claim ABC-12 --runtime conductor --handle <workspace>/<session>
armada report awaiting-approval --message-file plan.md     # first line = summary
armada report implementing --message "plan approved, writing the parser"
armada report implementing --message "parser done, wiring the CLI"   # same phase = status update
armada report shipping --message "PR open" --pr 34
armada report ready-to-merge --pr 34 --sha <full 40-character head SHA>
armada release --reason "wrong ticket"
```

- `claim` re-reads the ticket and refuses it when another worker holds it; if two claims race, the older comment wins and the other withdraws. It assigns the ticket to the Linear key's user, moves it to the team's first started state, sets the `planning` phase label and the runtime label (matched by name, so `conductor` finds `Conductor`), and posts an `Agent claim — runtime · session · branch · started` line. The handle is kept in that comment and on Armada, so a coordinator finds the session either way. Claiming again with the same handle repairs labels and state. It reads every comment and label of the ticket, however many.
- `report <phase>` accepts: planning → awaiting-approval or implementing; awaiting-approval → planning or implementing; implementing → shipping; shipping → implementing or ready-to-merge; ready-to-merge → shipping; blocked from anywhere and back to any phase; the current phase again as a status update. Anything else exits 1 with the reason. The output lists what waits in the worker's inbox.
- `report`, `ask` and `answer` accept `--message-file -` to read standard input to EOF, including a pipe or a shell heredoc. For example: `printf 'line one\nline two' | bun run armada report implementing --ticket ABC-12 --message-file -`. An explicitly empty or whitespace-only message file or stdin exits 2 before any tracker or database write, with a retry naming `--message` or a non-empty pipe. A `ready-to-merge` report may still omit the message option.
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
armada answer 12 "SQLite, for the first slice."                 # after delivering it in the worker's session
armada answer 13 "approved"                                   # a plan, after delivering approval
armada answer --note ABC-12 "main moved: bring it in before you ship"  # an unsolicited message, same path
```

- `ask` reports the `blocked` phase with `Agent status: blocked — question: <first line>` (the rest and the numbered options below it) and adds a `question` item to the coordinator's inbox on Armada. The worker then stops and waits for the answer in its session, and reports the phase it resumes. It finds the ticket like `report`.
- `report awaiting-approval` adds a `plan` item with the full message and worker handle to the coordinator's inbox. Same-phase heartbeats neither duplicate nor reopen it. Answering it, recording a note, leaving the phase or releasing the ticket closes the plan and any pending approval request. For a pre-approved plan, post the plan with `report implementing` instead: no approval item is needed.
- `inbox` lists the coordinator's open items (questions, plans, requests, hand-backs) and silent workers, oldest first. A worker is silent when it holds a ticket, its newest event is older than `policy.silence_minutes`, and its phase does not wait on someone else. It reads Armada only (a sign-in, no Linear key) and records that the coordinator is at work, for the dashboard. `--wait` asks Armada every 15 s until `--timeout`; Armada answers "not modified" (HTTP 304, no body) while the inbox holds the same entries, so a waiting coordinator costs one short request per ask and holds nothing open. It marks the items that were not there before with `*`; loop on it.
- `watch` is how a coordinator keeps listening, run in the background while a worker is in flight. It asks Armada like `inbox --wait` (every 15 s, every 60 s when no worker is in flight, 304 while nothing changed) with no time limit of its own, and exits as soon as something needs the coordinator that it has not been shown yet by `inbox` or `watch` on this machine: it prints the inbox, new items marked `*`. It exits with "nothing to watch" when no worker is in flight and nothing is open. Armada unreachable or answering 5xx only prints a warning and it keeps going, waiting longer each time; a refusal (signed out) ends it. One watch per project and machine: a second one says the first is running. Its state (a lock, the entries shown, the tickets in flight at the last read, the checkout it ran in) lives in `~/.config/armada/watch/`, no secret.
- The last line of `inbox`, `watch`, `merge` and `brief` (not `brief --prompt`) says whether to start watching again, for example `2 workers in flight (ABC-1, ABC-2) — keep watching: armada watch`; with `--json`, the same is the `watch` field.
- `armada hook stop` is the Claude Code Stop hook `armada init` adds to `.claude/settings.json` (it asks; `--no-stop-hook` leaves it out; `armada doctor` shows it). It reads only armada.toml and the watch state, so it answers at once without the network. It refuses to end the turn, and tells the agent to start `armada watch` in the background, only in the checkout where `armada watch` ran (never a worker's), while the last read had workers in flight and no watch runs. A watch that ended on a refusal lets the turn end, and `ARMADA_STOP_HOOK=off` turns the hook off.
- On the dashboard, an item open in the coordinator's inbox for longer than `policy.coordinator_minutes` (default 10) shows "waiting for the coordinator for N min" in "Waiting for you".
- A coordinator's own claim is never listed as silent in its inbox: only an exact, nonempty handle match is excluded, not its questions, requests or hand-backs. `inbox` takes the reading coordinator's handle from `ARMADA_COORDINATOR_HANDLE` first, otherwise from both `CONDUCTOR_WORKSPACE_ID` and `CONDUCTOR_SESSION_ID` joined as `workspace/session`. Blank values are ignored; with no complete identity, silence detection is unchanged. Local coordinators should set `ARMADA_COORDINATOR_HANDLE` to the handle used for their claim. The same identity is used for every `--wait` poll and the dashboard presence record; the fleet-wide `status` and dashboard silence rules are unchanged.
- `answer` never calls a runtime: deliver the answer first with the runtime guide's message section. It posts `Agent status: <current phase> — answer: …` on the ticket and resolves the item. An item id needs Armada; a ticket id answers that ticket's open questions and plans and also works without it. `--note` records a delivered note as `Agent status: <phase> — note: …`; it accepts a ticket or plan item id and resolves open plans, not questions. These two are the coordinator's records: Armada never reads them as the worker's phase, hand-back or sign of life. Questions, plans and requests can be answered; `merge` resolves hand-backs, and `release` and `merge` resolve the ticket's open questions. A worker that does not report within `policy.silence_minutes` of an answer shows as silent.
- The dashboard adds two kinds of request, signed by the person who made them. In "Waiting for you", **Approve** opens an editable approval (`approved` by default); sending it creates an `answer-request`, just like answering a question. Deliver its text, then `armada answer <request id> "<answer>"`, which resolves the request and its question or plan and names the requester on the ticket (answering the item itself also closes a waiting request). A `launch-request` asks to launch a ready ticket on a profile: launch it as usual; the worker's `armada claim` resolves it and posts who asked. To decline one, `armada answer <request id> "<why>"`: it is closed with the reason and nothing is posted on the ticket.

## Merge a finished pull request (coordinator)

```sh
armada merge 34 --dry-run   # the checklist only
armada merge 34             # or the pull request URL; --ticket ABC-12 when the branch names no ticket
```

- The checklist names every failure and exits 1: the ticket carries `ready-to-merge` and its newest `Agent status: ready-to-merge — PR #34, head <sha>` comment names this pull request with the full 40-character SHA of its current head; the pull request is open, not a draft, titled in Commitizen format and `CLEAN` for GitHub; every `[gates] required_checks` check is green on the head; no review thread is unresolved.
- A head that lacks commits of its base branch is refused, unless `[gates] local_commands` is set: then the head is merged into the base in a throwaway `git worktree`, the commands run there, and the worktree is removed.
- Hints, never blocking: top-level functions, classes, types and constants the pull request removes or renames that the base branch still uses in files the pull request does not touch.
- One merge at a time per project: a `merge` lease taken through Armada (20 minutes, renewed before the merge, atomic on its database and timed by its clock) makes a second coordinator wait. When the terminal is signed in but Armada is unreachable the merge is refused; `--no-lock` forces it, with a warning and "merged without lock" in the ticket's merged comment. Not signed in at all (one coordinator) the merge runs unlocked with a warning.
- The merge is `gh pr merge <n> --squash --match-head-commit <sha>`, never `--delete-branch` (it removes local worktrees that have the branch checked out). A GitHub 5xx is retried with backoff, each time after checking that the pull request is still open at the same head. Success is reported only once GitHub shows the pull request as merged at that head.
- Then the ticket moves to Done with its agent labels and `[tracker] ready_label` removed (unrelated labels stay), the pull request is linked, `Agent status: merged — …` is posted, the hand-back in the coordinator's inbox is resolved and the runtime handle released. The output lists the workers in flight to tell and the worker session to archive with its runtime guide, when one is installed for that runtime in `.agents/skills` or `.claude/skills`; otherwise it says there is none, since a local session or subagent has nothing to archive.
- It runs `gh` and `git` in the repository checkout and needs `LINEAR_API_KEY` and a GitHub token.

## Watch the fleet (dashboard)

`packages/dashboard` is a Next.js app whose main page is the Fleet of the projects registered in its database. With accounts, each person sees the projects of their organization; under the shared password, every project.

- **Waiting for you** comes first, across projects. It lists questions, blocked workers, plans to approve, hand-backs and silent workers, the most urgent first.
- **At work** has one row per ticket in flight. A row shows the project, the runtime and session, the six-step phase pipeline, time in phase, the last report, the pull request with its CI, and the flags (red CI, conflict, double claim).
- A filter shows one project. Each project shows whether its coordinator is active, from its last inbox read.
- **Answer** a question from its line in Waiting for you (an option of the question fills the answer in). **Ready to launch** lists the frontier with a Launch button and a profile picker, the routed profile preselected. Neither reaches a worker: each becomes a request in that project's coordinator inbox, signed with the signed-in person's name and address (with accounts) or with the name the viewer gives (under the shared password; remembered in a cookie, default `ARMADA_DASHBOARD_AUTHOR`), and shows as pending until the coordinator carries it out. The dashboard holds no runtime credential.
- It stays live without a reload, and no page waits for Linear or GitHub. Each project's last reading of Linear and GitHub is kept in the app's Postgres database, and every page and poll reads only that database: the reading, plus the fleet's live data (events, claims, inboxes, coordinator activity), so a recorded report shows within seconds. A reading older than a minute (ten minutes for a project both [webhooks](#webhooks) reached within the last day) is served as is and refreshed in the background, reading only what changed in Linear since and the pull requests; Linear is read whole every 30 minutes at most, and only while someone looks. The top bar says how old the oldest reading on the page is, so a stale view never passes for a live one. A new project shows "reading Linear and GitHub for the first time" for a few seconds.
- The page polls every 5 s while work is in flight (a worker, a request waiting for the coordinator, a first reading), every 30 s when the fleet is quiet, and not at all while its tab is hidden. The server answers 304 while nothing changed. Answer, Approve and Launch show as sent on the click; a refusal puts the form back with the reason.
- When that database is unreachable, a banner says so and the view falls back to the last readings the server holds, refreshed from Linear and GitHub.
- The interface is in English or French (`ARMADA_DASHBOARD_LANGUAGE`, or the EN/FR switch).

Try it locally with synthetic data and no key:

```sh
cd packages/dashboard
bun run demo:seed                     # a local PGlite database (Postgres in the process) with two invented projects
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
- Values are write-only: once saved, a secret is never shown again, only who set it and when. Each value is sealed with AES-256-GCM under its own data key, itself sealed by the master key, and bound to its organization, person and name.
- A signed-in terminal (a session of `armada login`, an organization API key, or a worker session) calls `POST /api/cli/credentials`. It receives the Linear key (the person's own first), so workers and coordinators can search and edit Linear freely. Answers are never cached; a terminal asking more than 30 times a minute is refused for a minute.
- No terminal ever receives a database key. Every read and write of the fleet's live data (claims, reports, questions and plans, the inbox, answers, the merge lock, the project registry) goes through `POST /api/cli/fleet/<operation>` with the terminal's sign-in. Armada checks each one: the project must belong to the caller's organization (a project is registered for the first organization that names it), and a worker session only claims, reports, asks and releases its own ticket. Times are Armada's.
- Every change and every key handed out is in the audit list at the bottom of the Keys page (owners and admins): who, which key, when; never a value.
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
- A worker signs in with the launch token of its launch message, as its first command: `armada login --launch-token <token>` (plus `--api-url <url>` for a self-hosted Armada, which the brief adds). The worker session it gets is kept per ticket in the credentials file and signs in that ticket's `claim`, `report`, `ask` and `release` only; each of them asks Armada for its keys, and stops with Armada's reason once the session is revoked (Organization > Workers) or ended (`armada release`, or the coordinator's `armada merge`). It lasts while the worker keeps reporting, up to three days idle.
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
silence_minutes = 15             # a worker with no report for longer is flagged silent (default 15)

[conductor]
default_profile = "opus"         # for tickets no routing rule matches (required with routing)

[conductor.profiles.opus]        # one table per profile; `conductor model` lists the ids
agent = "claude"
model = "opus-5-5-1m"
effort = "high"
# fast_mode = true               # optional, default false

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

The program follows one convention: specs are direct children of the root titled `Spec N/M — Name`, tickets are their sub-issues, and dependencies are Linear blocked-by relations. Agents declare their phase with a label from the phase group (`planning`, `awaiting-approval`, `implementing`, `shipping`, `blocked`, `ready-to-merge`) and start every comment with `Agent status: <phase> — <summary>`.

## Develop

Use the [Bun](https://bun.sh) version pinned in `package.json`'s `packageManager`
(currently 1.4.2). CI and release builds read the same pin.

```sh
bun install
bun run armada status   # run the CLI from source
bun run verify          # lint, typecheck, tests
```

See [AGENTS.md](https://github.com/The-Vibe-Company/armada/blob/main/AGENTS.md) for the layout and the rules.

## What it is made of

- **`armada` CLI** (TypeScript). The coordinator and the workers call it to claim tickets, report progress, ask and answer questions, launch workers and merge.
- **Skills** vendored into the managed repository by `armada init`: the coordinator loop, the worker protocol and one runtime guide per runtime. They live in [`skills/`](skills).
- **Linear** holds the plan: specs, tickets, dependencies and agent phases.
- **The app's database** (Postgres, e.g. Neon) holds the accounts, the organizations' sealed keys and the fleet's live data: events, heartbeats, pending questions and locks. The CLI reaches it only through the Armada API, with its sign-in. Losing it loses live detail, never progress.
- **Conductor Cloud** runs the workers in the first version. Other runtimes come later without changing the worker contract.
- **Dashboard** (Next.js, `packages/dashboard`): the live Fleet view of every project. The program view comes later.

## License

MIT
