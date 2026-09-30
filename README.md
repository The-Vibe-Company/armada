# Armada

Armada runs a fleet of coding agents on one project and keeps every piece of work visible.

It imposes one method: grill the decisions, write a spec, cut it into tickets, let one worker agent ship each ticket as a green pull request, and let a coordinator agent merge. The tracker is the source of truth for progress; Armada adds live telemetry, contention rules and a fleet dashboard on top.

**Status:** early. `armada status`, `armada auth`, `armada doctor`, `armada init`, `armada claim`, `armada report` and `armada release` work; the other commands are being built.

## Install

Requires [Node.js](https://nodejs.org) 22 or later: `npx` and `bunx` both run the command with Node.

```sh
npx @the-vibe-company/armada status     # or: bunx @the-vibe-company/armada status
npm install -g @the-vibe-company/armada  # then: armada status
```

`armada --version` prints the installed version. Each release is listed on [GitHub releases](https://github.com/The-Vibe-Company/armada/releases) with its changelog.

## Try it

```sh
armada auth login   # once per machine: asks for the missing keys, input hidden
armada status       # or: armada status --json
```

`armada status` reads the `armada.toml` of the current repository (or the nearest parent directory) and prints:

- **In flight**: tickets an agent holds, with their phase, runtime, last report and pull request. A worker with no report (an `armada report` event in Turso, an `Agent status:` comment or its claim) for longer than `policy.silence_minutes` is flagged `silent`, unless it is waiting on a human (`awaiting-approval`, `blocked`, `ready-to-merge`). A ticket that never had a report falls back to its last sign of life (ticket edit, comment or pull request update).
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
- the Linear label groups `Agent phase` and `Agent runtime` exist with every value (needs `LINEAR_API_KEY`).

Each problem is an error or a warning, with its fix. A missing skill is an error: workers cannot run without it. A skill that differs from this Armada version, or a missing ignore line, is a warning. Doctor exits 1 when there is an error. `--json` prints the same report as JSON.

`armada init` fixes everything doctor reports in one go:

1. It creates the missing Linear labels (a missing group goes in the team of the program root).
2. It builds the missing or outdated files on a fresh checkout of the default branch, commits them on the branch `armada/init-<version>` and opens a pull request with `gh`. Your own checkout is not touched. Running it again rebuilds that branch and updates the same pull request. When the default branch already has everything, no pull request is opened.
3. It registers the project (slug, name, repository, program root) in the Turso database, so `armada status --all` and the dashboard list it.

On a repository without `armada.toml`, pass `--program-root <ISSUE-ID>`; the name comes from the GitHub repository unless you pass `--name`, and the slug from the name unless you pass `--slug`. An existing `armada.toml` is never replaced. `init` needs `git`, the GitHub CLI logged in (`gh auth login`), `LINEAR_API_KEY` and `ARMADA_TURSO_URL`; on a terminal it asks for missing keys first.

`armada status --all` prints the status of every registered project, each read with the `armada.toml` on its repository's default branch. A project that cannot be read shows its error without hiding the others.

## Work on a ticket (workers)

A worker writes to the tracker only through three commands. They set the labels and write the comments in the protocol format, and record each event in Turso.

```sh
armada claim ABC-12 --runtime conductor --handle <workspace>/<session>
armada report awaiting-approval --message-file plan.md     # first line = summary
armada report implementing --message "plan approved, writing the parser"
armada report implementing --message "parser done, wiring the CLI"   # same phase = status update
armada report shipping --message "PR open" --pr 34
armada report ready-to-merge --pr 34 --sha <full 40-character head SHA>
armada release --reason "wrong ticket"
```

- `claim` re-reads the ticket and refuses it when another worker holds it; if two claims race, the older comment wins and the other withdraws. It assigns the ticket to the Linear key's user, moves it to the team's first started state, sets the `planning` phase label and the runtime label (matched by name, so `conductor` finds `Conductor`), and posts an `Agent claim — runtime · session · branch · started` line. The handle is kept in that comment and in Turso, so a coordinator finds the session either way. Claiming again with the same handle repairs labels and state.
- `report <phase>` accepts: planning → awaiting-approval or implementing; awaiting-approval → planning or implementing; implementing → shipping; shipping → implementing or ready-to-merge; ready-to-merge → shipping; blocked from anywhere and back to any phase; the current phase again as a status update. Anything else exits 1 with the reason. The output lists what waits in the worker's inbox.
- `ready-to-merge` is refused unless the pull request is open in the project repository, `--sha` is the full 40-character SHA of its head, and every check in `[gates] required_checks` is green on that head (with none declared: at least one check, all green). It needs a GitHub token.
- `release` removes the phase and runtime labels, moves the ticket back to the team's first unstarted state and posts `Agent status: released — <reason>`.
- `report` and `release` find the ticket from `--ticket`, then `ARMADA_TICKET`, then the current git branch (`feature/abc-12-…`).
- Turso is optional. When it is not configured or not reachable, the commands still write Linear and print a warning.

## Keys

Armada needs a few keys. Set them up once per machine with `armada auth login`, or pass them as environment variables, which always win over the stored ones (the way to go in CI and cloud sandboxes).

| Variable | What | Needed by |
| --- | --- | --- |
| `LINEAR_API_KEY` | Linear personal API key (Linear > Settings > Security & access > Personal API keys) | `armada status` |
| `ARMADA_TURSO_URL` | Turso database URL, `libsql://...` (`file:/path/armada.db` for a local database) | `armada init` and `armada status --all` (project registry); live activity: events, runtime handles, inbox (optional) |
| `ARMADA_TURSO_TOKEN` | Turso database token | the same (optional for a `file:` database) |
| `GITHUB_TOKEN` or `GH_TOKEN` | GitHub token; otherwise `gh auth token` is used | pull requests and CI |

- `armada auth login` asks only for the keys that are missing, with hidden input for tokens, and stores them in `~/.config/armada/credentials` (or `$XDG_CONFIG_HOME/armada/credentials`), mode 0600 in a 0700 directory. Without a terminal it asks nothing and lists the variables to set instead.
- `armada auth status [--json]` shows which keys are set and where each comes from. It never prints a value.
- `armada auth logout` removes Armada's keys from the file.

The credentials file is a plain dotenv file (`KEY=value` lines, `#` comments) that a shell can also `source`. You may edit it by hand; Armada keeps your other lines and comments when it updates it. GitHub tokens are not stored there: use the environment or `gh auth login`.

Non-secret personal defaults go in `config.toml` next to it, created by the first `armada auth login`:

```toml
language = "en"                  # your language (BCP 47 tag)

[turso]
url = "libsql://<database>-<organization>.turso.io"   # used when ARMADA_TURSO_URL is not set

[dashboard]
url = "https://<your-armada-dashboard>"
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
required_checks = ["test"]       # CI checks that must be green before a hand-back (default: every check)

[policy]
silence_minutes = 15             # a worker with no report for longer is flagged silent (default 15)
```

A missing or invalid key stops the command with a message naming it, for example `missing required key "tracker.program_root"`. This repository's own configuration is in [`armada.toml`](https://github.com/The-Vibe-Company/armada/blob/main/armada.toml).

The program follows one convention: specs are direct children of the root titled `Spec N/M — Name`, tickets are their sub-issues, and dependencies are Linear blocked-by relations. Agents declare their phase with a label from the phase group (`planning`, `awaiting-approval`, `implementing`, `shipping`, `blocked`, `ready-to-merge`) and start every comment with `Agent status: <phase> — <summary>`.

## Develop

Requires [Bun](https://bun.sh) 1.3 or later.

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
- **Turso** (libSQL) holds live telemetry: events, heartbeats, pending questions and locks. Losing it loses live detail, never progress.
- **Conductor Cloud** runs the workers in the first version. Other runtimes come later without changing the worker contract.
- **Dashboard**: the live fleet view and the program view.

## License

MIT
