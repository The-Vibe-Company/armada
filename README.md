# Armada

Armada runs a fleet of coding agents on one project and keeps every piece of work visible.

It imposes one method: grill the decisions, write a spec, cut it into tickets, let one worker agent ship each ticket as a green pull request, and let a coordinator agent merge. The tracker is the source of truth for progress; Armada adds live telemetry, contention rules and a fleet dashboard on top.

**Status:** early. `armada status` and `armada auth` work; the other commands are being built.

## Install

Requires [Node.js](https://nodejs.org) 22 or later, or [Bun](https://bun.sh).

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

- **In flight**: tickets an agent holds, with their phase, runtime, last update and pull request. An agent with no sign of life (ticket edit, comment or pull request update) for longer than `policy.silent_after_minutes` is flagged `silent`, unless it is waiting on a human (`awaiting-approval`, `blocked`, `ready-to-merge`).
- **Ready to start**: tickets without sub-issues that are not started, not held by an agent, have no open pull request, and whose blocked-by tickets are all closed, ranked by what they unlock. Tickets without the ready label, or still in triage, are listed separately.
- **Pull requests waiting**: open pull requests with their CI state and mergeability.

GitHub is read with `GITHUB_TOKEN`, `GH_TOKEN` or the GitHub CLI login (`gh auth token`). Without any of them the tickets are still shown.

## Keys

Armada needs a few keys. Set them up once per machine with `armada auth login`, or pass them as environment variables, which always win over the stored ones (the way to go in CI and cloud sandboxes).

| Variable | What | Needed by |
| --- | --- | --- |
| `LINEAR_API_KEY` | Linear personal API key (Linear > Settings > Security & access > Personal API keys) | `armada status` |
| `ARMADA_TURSO_URL` | Turso database URL, `libsql://...` | live activity (coming) |
| `ARMADA_TURSO_TOKEN` | Turso database token | live activity (coming) |
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

[github]
repository = "acme/widgets"      # owner/name (required)

[policy]
silent_after_minutes = 15        # default 15
```

A missing or invalid key stops the command with a message naming it, for example `missing required key "tracker.program_root"`. This repository's own configuration is in [`armada.toml`](armada.toml).

The program follows one convention: specs are direct children of the root titled `Spec N/M — Name`, tickets are their sub-issues, and dependencies are Linear blocked-by relations. Agents declare their phase with a label from the phase group (`planning`, `awaiting-approval`, `implementing`, `shipping`, `blocked`, `ready-to-merge`) and start every comment with `Agent status: <phase> — <summary>`.

## Develop

Requires [Bun](https://bun.sh) 1.3 or later.

```sh
bun install
bun run armada status   # run the CLI from source
bun run verify          # lint, typecheck, tests
```

See [AGENTS.md](AGENTS.md) for the layout and the rules.

## What it is made of

- **`armada` CLI** (TypeScript). The coordinator and the workers call it to claim tickets, report progress, ask and answer questions, launch workers and merge.
- **Skills** vendored into the managed repository: the coordinator and worker protocols, planning and shipping skills.
- **Linear** holds the plan: specs, tickets, dependencies and agent phases.
- **Turso** (libSQL) holds live telemetry: events, heartbeats, pending questions and locks. Losing it loses live detail, never progress.
- **Conductor Cloud** runs the workers in the first version. Other runtimes come later without changing the worker contract.
- **Dashboard**: the live fleet view and the program view.

## License

MIT
