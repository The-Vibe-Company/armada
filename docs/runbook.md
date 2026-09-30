# Runbook: start a coordinator

A coordinator is an agent session (Claude Code, Codex or another) that follows the `armada-coordinator` skill on one project: it launches workers, answers their questions, merges their pull requests and reports to the owner. Its state lives in Linear, GitHub and Turso, never in its own context, so it can be started anywhere: on a laptop, or in a Conductor Cloud workspace. This runbook says what the owner sets up once, how to start a coordinator in each place, and how one coordinator hands over to the next.

One project has one coordinator at a time.

## What the owner sets once

| What | Who owns it | Where it goes |
| --- | --- | --- |
| `LINEAR_API_KEY`, a Linear personal API key (Linear > Settings > Security & access > Personal API keys) | the owner; tickets are claimed and commented as that Linear user | laptop: `armada auth login`; cloud: the organization environment |
| `ARMADA_TURSO_URL` and `ARMADA_TURSO_TOKEN`, the organization's Turso database | the owner; one database per organization, shared by every project | the same |
| GitHub access: push, open and merge pull requests | the owner's GitHub account | laptop: `gh auth login`; cloud: Conductor signs `gh` in (`GH_TOKEN`) |
| Conductor access, to launch and message workers | the owner's Conductor account | laptop: the Conductor app and `conductor auth login` (macOS); cloud: Conductor sets `CONDUCTOR_API_KEY` in every workspace |

- **The repository is set up**: `armada doctor` passes, or `armada init` opened its setup pull request and it is merged (`armada.toml`, the skills in `.agents/skills`, `.conductor/settings.toml`, the Linear label groups, the project registered in Turso).
- **The Conductor Cloud organization environment** holds `LINEAR_API_KEY`, `ARMADA_TURSO_URL` and `ARMADA_TURSO_TOKEN`: add them as environment variables in the settings of the organization's cloud computer. Every cloud workspace, the coordinator's and each worker's, then starts with them, and a launch needs no `--env` for them. Anyone who can start a workspace in the organization can use these keys: keep the organization to people you trust with them. This is the setup today. With an Armada that keeps the organization's keys (the README's "Keys kept in Armada"), a signed-in coordinator needs none of them in its environment: `armada login`, or `ARMADA_API_KEY` for a headless one. Workers still receive them until launch tokens arrive (the next slice of Spec 2/3).
- **The dashboard** (optional) is deployed with its own keys, as the README's "Watch the fleet" section describes. It never needs a runtime key.
- **The coordination ticket** (optional): when a run has a goal of its own ("run this ticket end to end", "ship this spec"), create a ticket for it. The coordinator claims it, reports on it and hands over through it.

Never paste a key into a prompt, a ticket, a file in the repository or a chat.

## Start a coordinator on a laptop

1. Install Armada (Node.js 22 or later) and check the keys. `armada auth status` never prints a value.

   ```sh
   npm install -g @the-vibe-company/armada
   armada auth login     # once per machine: asks only for the missing keys
   armada auth status
   gh auth status
   conductor auth whoami
   ```

2. Open a checkout of the repository on its default branch, up to date, and start your agent there (for example `claude` or `codex`). The skills are in `.agents/skills`, linked from `.claude/skills`.
3. Give it the launch prompt below. Its handle is one you choose and that names the session, for example `coordinator-<your name>-laptop`, and its runtime is the one it runs in (`claude-code`, `codex`).

The laptop must stay awake and online while the coordinator runs: when it sleeps, nobody answers the workers. For a long run, start the coordinator in Conductor Cloud instead.

Workers launched from a laptop get the keys through the `--env` lines of the runtime guide's launch command, from your shell or from Armada's credentials file. When the organization environment already holds them, drop those lines.

## Start a coordinator in Conductor Cloud

1. Create a workspace on the repository, from the Conductor app or with the CLI, with the agent and model you want for the coordinator:

   ```sh
   conductor --json workspace create \
     --repo-url https://github.com/<owner>/<name> \
     --branch main \
     --name "Coordinator" \
     --agent claude --model opus-5-5-1m --effort high \
     --message-file - < coordinator-prompt.md
   ```

   The keys come from the organization environment; pass no `--env`.
2. Give it the launch prompt below (the `--message-file` above, or the first message in the app). The coordinator's runtime is `conductor` and its handle `$CONDUCTOR_WORKSPACE_ID/$CONDUCTOR_SESSION_ID`, both set by Conductor in the workspace.
3. Its first commands install Armada and check that the keys arrived: `armada auth status` shows each key as coming from the environment, `conductor auth whoami` exits 0 and `gh auth status` is logged in. Inside the workspace, `conductor auth status` fails ("Keychain storage is only supported on macOS"): that is expected, and `whoami` is the check.

A missing key is fixed in the organization environment; start a new workspace if the running one does not see it.

## The launch prompt

The same prompt works in both places. Everything else comes from the repository, the tracker and Turso.

```text
You are the Armada coordinator of this repository. Follow the armada-coordinator skill,
starting with its "Take over a run" section.

Install Armada first: npm install -g @the-vibe-company/armada
Your coordination ticket is ABC-12.
Your runtime is conductor and your handle "$CONDUCTOR_WORKSPACE_ID/$CONDUCTOR_SESSION_ID".
```

Leave out the ticket line when there is no coordination ticket. On a laptop, write your runtime and the handle you chose.

Add only what exists nowhere else: an instruction from the owner for this run ("do not launch new tickets today"). A fact the next coordinator will also need belongs on the ticket or in the repository, not in the prompt.

## Hand over between coordinators

1. The coordinator that stops releases its coordination ticket with the state it leaves: `armada release --ticket ABC-12 --reason "<who runs, what was asked and answered, what remains>"`. That posts `Agent status: released — <reason>` on the ticket.
2. Stop it: close the session, or archive its workspace (`conductor --json workspace archive <workspaceId>`).
3. Start the next one with the launch prompt. It reads the `released` comment, claims the ticket with its own handle, and reads `armada status` and `armada inbox`.

Without a coordination ticket, skip step 1: the next coordinator resumes from `armada status` and `armada inbox` alone.

## When something is missing

- `armada` reports a missing key: set it (laptop: `armada auth login`; cloud: the organization environment and a new workspace).
- `armada inbox` needs Turso; without it, questions and hand-backs are on the tickets only, and `armada status` still reads the fleet from Linear.
- `conductor` exits 3: check `conductor auth whoami`. A command refused by your `conductor` version: compare with `conductor <command> --help`; the runtime guide names the versions it was checked against.
- A fact the coordinator could not find in the repository, the tracker or Turso: add it to the skill or to this runbook in a pull request, so the next coordinator finds it.
