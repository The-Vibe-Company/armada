# Runbook: start a coordinator

A coordinator is an agent session (Claude Code, Codex or another) that follows the `armada-coordinator` skill on one project: it launches workers, answers their questions, merges their pull requests and reports to the owner. Its state lives in Linear, GitHub and Armada, never in its own context, so it can be started anywhere: on a laptop, or in a Conductor Cloud workspace. It signs in to Armada, which keeps the organization's keys; no runtime needs a key of its own. This runbook says what the owner sets up once, how to start a coordinator in each place, and how one coordinator hands over to the next.

One project has one coordinator at a time.

## What the owner sets once

| What | Who owns it | Where it goes |
| --- | --- | --- |
| The Armada organization | the owner | sign in to Armada (the dashboard) with GitHub and create the organization; invite the others from the Organization page |
| The organization's key: `LINEAR_API_KEY` (Linear > Settings > Security & access > Personal API keys) | the owner; tickets are claimed and commented as that Linear user, unless a person adds their own Linear key | Armada: Organization > Keys. Nowhere else |
| The coordinator's sign-in | the person who runs it | laptop: `armada login`; cloud: an organization API key (Organization page, owners only), given to the coordinator's own workspace as `ARMADA_API_KEY` |
| GitHub access: push, open and merge pull requests | the owner's GitHub account | laptop: `gh auth login`; cloud: Conductor signs `gh` in (`GH_TOKEN`) |
| Conductor access, to launch and message workers | the owner's Conductor account | laptop: the Conductor app and `conductor auth login` (macOS); cloud: Conductor sets `CONDUCTOR_API_KEY` in every workspace |

- **The repository is set up**: `armada doctor` passes, or `armada init` opened its setup pull request and it is merged (`armada.toml`, the skills in `.agents/skills`, `.conductor/settings.toml`, the Linear label groups, the project registered on Armada for the organization).
- **No runtime holds a fleet key.** A signed-in coordinator gets the organization's Linear key from Armada on each command, and each worker gets a one-time launch token in its launch message: its first command, `armada login --launch-token`, exchanges it for a session limited to its ticket, through which Armada gives it the Linear key. No machine holds a database key: claims, reports, questions, the inbox, the merge lock and the project registry go through the Armada API with the sign-in. Conductor's organization environment holds no Armada key: not `LINEAR_API_KEY`, and not `ARMADA_API_KEY` either, since every workspace starts with that environment and a worker would then act with the coordinator's rights.
- **Secrets workers need to build and test** (an LLM provider key, a test database URL) are kept per project in Armada, not in Conductor's environment: the coordinator moves each one with `armada secrets set <NAME> --from-env <NAME>` (owner or admin), and workers run their tests with `armada run -- <command>`. List the names in `[secrets] names` of `armada.toml` so `armada doctor` says which are missing.
- **Environment variables stay an override**, for CI and for an Armada without accounts (self-hosting): a key set in the environment wins over Armada's. Until the organization's keys are on the Keys page, keys in Conductor's organization environment keep a fleet running as before (the runtime guide's launch with keys).
- **The dashboard** (optional) is deployed with `ARMADA_DATABASE_URL`, the accounts variables and `ARMADA_SECRETS_KEY`, as the README's "Watch the fleet" section describes. It never needs a runtime key.
- **The coordination ticket** (optional): when a run has a goal of its own ("run this ticket end to end", "ship this spec"), create a ticket for it. The coordinator claims it, reports on it and hands over through it.

Never paste a key into a prompt, a ticket, a file in the repository or a chat. A launch token is the one exception, made for it: it works once, within the hour, for one ticket.

## Move the keys out of Conductor

For a fleet that ran with the keys in Conductor's organization environment:

1. Enter the keys on Armada's Keys page (Organization > Keys), and create an organization API key for cloud coordinators (Organization page).
2. Check from a terminal with none of the keys in its environment: `armada login`, then `armada doctor` says `signed in to <Armada> as <you>, <organization>`, `armada auth status` shows each key from `Armada: …`, and `armada brief <ticket>` shows `Launch: one-time token in the prompt`.
3. Remove `LINEAR_API_KEY`, and any database variable of earlier versions, from the settings of Conductor's organization cloud computer. Workspaces started afterwards no longer have them; running ones keep what they started with until they are archived.
4. Start the next coordinator with its API key (below). On a laptop that kept keys in its credentials file, `armada doctor` warns once Armada gives the same ones: `armada auth logout` removes them and keeps the sign-in.

## Move the app to one Postgres database

Armada's app (the dashboard and the API terminals sign in to) keeps everything in one Postgres database: accounts, organizations, the vault, the workers, and the fleet's live data it shows. Earlier versions kept accounts and the fleet in databases of their own. The move starts on an empty database: nothing is copied, people sign in again.

1. Create a Postgres database in the region of the app's functions. On Neon: a project in `aws-eu-central-1` for the `fra1` region that `packages/dashboard/vercel.json` sets (change one or the other so they match). Keep Neon's managed auth off: the app runs Better Auth itself.
2. On the deployment, set `ARMADA_DATABASE_URL` to the database's pooled connection string, and remove `ARMADA_AUTH_DATABASE_URL`, `ARMADA_AUTH_DATABASE_TOKEN` and the fleet database variables of earlier versions (the app reads none of them). Keep `ARMADA_AUTH_SECRET`, `ARMADA_AUTH_URL`, `ARMADA_AUTH_GITHUB_CLIENT_ID`, `ARMADA_AUTH_GITHUB_CLIENT_SECRET`, `ARMADA_AUTH_OWNER_EMAILS` and `ARMADA_SECRETS_KEY`. Set them before the deploy of step 3: a deployment of this version without `ARMADA_DATABASE_URL` fails closed (503) and names it.
3. Deploy. Optionally apply the schema first, from `packages/dashboard`: `ARMADA_DATABASE_URL=<direct, not pooled, URL> bun run db migrate`; otherwise the first request applies it.
4. Sign in with GitHub as an owner address and create the organization; invite the others again.
5. Enter the organization's keys again on Organization > Keys, and create new organization API keys for cloud coordinators: the old database's sessions, API keys and launch tokens do not carry over. Every terminal runs `armada login` again; a cloud coordinator gets its new key as `ARMADA_API_KEY`.
6. Register each project once: `armada init` from a signed-in terminal registers it for that terminal's organization, and so does the first claim, report or inbox read of a signed-in terminal. From `packages/dashboard`, `ARMADA_DATABASE_URL=<URL> bun run db register <path to the project's armada.toml>` registers one with no organization; it joins the first organization on the next dashboard read.

## Reach the fleet through Armada

From this version on, the CLI reads and writes the fleet's live data only through the Armada API (`/api/cli/fleet/*`), with the terminal's sign-in. The cut-over:

1. Deploy the app first: its routes serve the CLI, and its migration removes the database access the vault kept for terminals.
2. Every terminal installs this CLI version and is signed in: `armada login` on a laptop, `ARMADA_API_KEY` for a cloud coordinator, a launch token for each worker. `armada login` also removes the database variables of earlier versions from the credentials file.
3. Remove the database variables of earlier versions wherever they are still set (Conductor's environment, a laptop's shell, the deployment): nothing reads them.
4. Check from a terminal with no database variable at all: `armada inbox`, `armada status` and `armada merge <pr> --dry-run` work, and the dashboard's live view shows the claims and reports.

A terminal not signed in still claims, reports and releases in Linear, with a warning that the live record was skipped; `armada inbox`, `armada watch`, `armada init` and `armada status --all` need a sign-in.

## Read GitHub through the Armada GitHub App

The app signs people in and reads GitHub for the dashboard (pull requests, CI checks, `armada.toml`) through one GitHub App with read-only rights, so the CI of private repositories shows and no GitHub token is set by hand. Terminals are unchanged: they keep `gh` (merges included) and `GITHUB_TOKEN`.

1. Create the GitHub App as the README's "GitHub App" section lists: callback URL `<dashboard>/api/auth/callback/github`, setup URL `<dashboard>/organization/github` with Redirect on update, the webhook of the next section (or none yet), repository permissions Actions, Checks, Commit statuses, Contents, Metadata and Pull requests all read-only, account permission Email addresses read-only. Generate a client secret and a private key.
2. On the deployment, set `ARMADA_GITHUB_APP_ID` and `ARMADA_GITHUB_APP_PRIVATE_KEY`, and replace the values of `ARMADA_AUTH_GITHUB_CLIENT_ID` and `ARMADA_AUTH_GITHUB_CLIENT_SECRET` with the app's Client ID and client secret. Redeploy.
3. Install the app on each GitHub account that holds a project (the app's page > Install App).
4. Sign out and sign in with GitHub again (the sign-in now goes through the app). Organization > GitHub names the app; in another organization than the first, an owner or admin clicks Install on GitHub there, picks the repositories, and comes back with the installation linked.
5. Check the Fleet view: every project shows its pull requests and CI. Then delete the GitHub token on Organization > Keys and remove `GITHUB_TOKEN` from the deployment. The old OAuth app can be deleted on GitHub.

## Keep the dashboard fresh with webhooks

Without webhooks the dashboard refreshes a project's reading of Linear and GitHub when someone looks at it and it is older than a minute. With them, a change shows within seconds and nothing runs while nobody looks.

1. Create a secret for GitHub (`openssl rand -hex 32`). On the GitHub App's settings, turn the webhook on: URL `<dashboard>/api/webhooks/github`, that secret; Permissions & events > Subscribe to events: Pull request, Check suite, Check run, Status.
2. In Linear, Settings > API > Webhooks: a new webhook to `<dashboard>/api/webhooks/linear` for Issues, Comments, Issue attachments and Issue labels. Copy its signing secret.
3. On the deployment, set `ARMADA_GITHUB_WEBHOOK_SECRET` and `ARMADA_LINEAR_WEBHOOK_SECRET`, and redeploy.
4. Check: GitHub's Recent Deliveries and Linear's webhook page show answers 202. Change a ticket's label or push to a pull request: the Fleet view shows it within about ten seconds, and the top bar's "Linear and GitHub read … ago" resets.

No cron is needed: nothing reads Linear or GitHub on a timer, so the database can scale to zero when nobody looks.

## Start a coordinator on a laptop

1. Install Armada (Node.js 22 or later) and sign in. `armada doctor` checks the repository and the sign-in; `armada auth status` shows where each key comes from, never a value.

   ```sh
   npm install -g @the-vibe-company/armada
   armada login          # once per machine: approve the code in the browser
   armada doctor
   gh auth status
   conductor auth whoami
   ```

2. Open a checkout of the repository on its default branch, up to date, and start your agent there (for example `claude` or `codex`). The skills are in `.agents/skills`, linked from `.claude/skills`.
3. Give it the launch prompt below. Its handle is one you choose and that names the session, for example `coordinator-<your name>-laptop`, and its runtime is the one it runs in (`claude-code`, `codex`).

The laptop must stay awake and online while the coordinator runs: when it sleeps, nobody answers the workers. For a long run, start the coordinator in Conductor Cloud instead.

Workers launched from a laptop need no key either: the brief's prompt carries their launch token.

A coordinator in Claude Code can also run short tickets as its own background subagents, each in its own git worktree: give those tickets a profile with `runtime = "claude-code"` and follow the `armada-runtime-claude-code` skill. They die with the coordinator's session, so anything long goes to Conductor.

## Start a coordinator in Conductor Cloud

1. Create a workspace on the repository with the agent and model you want for the coordinator, and its organization API key, from a shell where `ARMADA_API_KEY` is set (never typed into the command):

   ```sh
   conductor --json workspace create \
     --repo-url https://github.com/<owner>/<name> \
     --branch main \
     --name "Coordinator" \
     --agent claude --model opus-5-5-1m --effort high \
     --env ARMADA_API_KEY="$ARMADA_API_KEY" \
     --message-file - < coordinator-prompt.md
   ```

   `--env` reaches this workspace only; the workers it launches never see the key. Without an API key, start the workspace without that line and have the coordinator run `armada login`: it prints a code, which you approve on Armada's `/device` page.
2. Give it the launch prompt below (the `--message-file` above, or the first message in the app). The coordinator's runtime is `conductor` and its handle `$CONDUCTOR_WORKSPACE_ID/$CONDUCTOR_SESSION_ID`, both set by Conductor in the workspace.
3. Its first commands install Armada and check the sign-in: `armada doctor` says `signed in to <Armada> as the API key "<name>" of <organization>`, `armada auth status` shows each key from `Armada: …`, `conductor auth whoami` exits 0 and `gh auth status` is logged in. Inside the workspace, `conductor auth status` fails ("Keychain storage is only supported on macOS"): that is expected, and `whoami` is the check.

A revoked or wrong API key shows in `armada doctor`: create a new one and start a new workspace with it.

## The launch prompt

The same prompt works in both places. Everything else comes from the repository, the tracker and Armada.

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

- `armada` reports a missing key: `armada doctor` says whether the terminal is signed in; signed in, the key is missing from Armada's Keys page. On an Armada without accounts, set it in the environment or with `armada auth login`.
- `armada brief` shows `Launch: no launch token (…)`: the reason says what to fix, usually the sign-in (`armada login`, or `ARMADA_API_KEY`). A worker whose token was refused or who was cut off gets a new brief's `armada login --launch-token` line, as the runtime guide says.
- `armada inbox` needs a sign-in to Armada; without one, questions, plans and hand-backs are on the tickets only, and `armada status` still reads the fleet from Linear. Approve or amend each `plan` from the inbox, deliver the decision through the runtime guide, then record it with `armada answer <item> "<decision>"`. Pre-approved plans go straight to `implementing`: set `[policy] plans = "pre-approved"` in `armada.toml` (or label a ticket `plan-approved`) and every brief tells its worker so. What every worker must know (checks to run, generated files, how to bring main in) goes once in the file `[brief] extra` names.
- A Claude Code coordinator is refused the end of its turn by the stop hook: workers are in flight and no `armada watch` runs in its checkout. Start `armada watch` in the background; once nothing is in flight it exits "nothing to watch" and the hook lets the turn end. If the hook itself misbehaves, set `ARMADA_STOP_HOOK=off` in the coordinator's environment and report it.
- `conductor` exits 3: check `conductor auth whoami`. A command refused by your `conductor` version: compare with `conductor <command> --help`; the runtime guide names the versions it was checked against.
- A fact the coordinator could not find in the repository, the tracker or Armada: add it to the skill or to this runbook in a pull request, so the next coordinator finds it.
