# Armada

Armada runs a fleet of coding agents on one project and keeps every piece of work visible.

It imposes one method: grill the decisions, write a spec, cut it into tickets, let one worker agent ship each ticket as a green pull request, and let a coordinator agent merge. The tracker is the source of truth for progress; Armada adds live telemetry, contention rules and a fleet dashboard on top.

**Status:** early. `armada status` works; the other commands are being built.

## Try it

Requires [Bun](https://bun.sh) 1.3 or later.

```sh
bun install
export LINEAR_API_KEY=lin_api_...   # Linear > Settings > Security & access > Personal API keys
bunx armada status                  # or: bunx armada status --json
```

`armada status` reads the `armada.toml` of the current repository (or the nearest parent directory) and prints:

- **In flight**: tickets an agent holds, with their phase, runtime, last update and pull request. An agent that has not posted anything for longer than `policy.silent_after_minutes` is flagged `silent`.
- **Ready to start**: tickets not started whose blocked-by tickets are all closed, ranked by what they unlock. Tickets without the ready label are listed separately.
- **Pull requests waiting**: open pull requests with their CI state and mergeability.

GitHub is read with `GITHUB_TOKEN`, `GH_TOKEN` or the GitHub CLI login (`gh auth token`). Without any of them the tickets are still shown.

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

```sh
bun run verify   # lint, typecheck, tests
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
