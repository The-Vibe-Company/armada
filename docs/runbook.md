# Runbook: start a coordinator

## Worker liveness

Launch briefs start a heartbeat immediately after claim. On Conductor Cloud it must detach from the short-lived command shell: `armada heartbeat --every 5m --parent "$PPID" --background` uses a new process group (like `nohup` + `setsid`) and a PID file under `~/.config/armada/watch/`. Plain background `&` and `nohup` alone can be killed by command-tool cleanup. The persistent agent parent must survive between turns; do not pass the shell's `$$`. The PID file prevents duplicates for the same current claim.

Claude Code subagents use their own background Bash (`run_in_background: true`), never detached startup: background Bash dies with the subagent, which is intended. Where no background process is possible, or startup fails, the worker records the fallback and reports manually at least every 15 minutes. Older CLIs retain that manual rule. Heartbeats stop with the parent or when Armada releases, merges or revokes the current session.

Reports are progress at real steps, not liveness. Configure missing liveness with `[policy] silence_minutes` (15 by default) and a live worker without progress with `quiet_minutes` (45 by default). A quiet worker gets a softer coordinator-only note; it is not an owner action or a red dashboard state.

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
2. Check from a terminal with none of the keys in its environment: `armada login`, then `armada doctor` says `signed in to <Armada> as <you>, <organization>`, and `armada auth status` shows each key from `Armada: …`. `armada brief <ticket>` and `--json` are read-only: they show `Launch: a one-time token is made when you print the prompt (--prompt)`, without a token or a launch row. At launch, one `armada brief <ticket> --prompt --profile-line` call supplies the worker prompt on stdout and the chosen profile and reason on stderr.
3. Remove `LINEAR_API_KEY`, and any database variable of earlier versions, from the settings of Conductor's organization cloud computer. Workspaces started afterwards no longer have them; running ones keep what they started with until they are archived.
4. Start the next coordinator with its API key (below). On a laptop that kept keys in its credentials file, `armada doctor` warns once Armada gives the same ones: `armada auth logout` removes them and keeps the sign-in.

## Move the app to one Postgres database

Armada's app (the dashboard and the API terminals sign in to) keeps everything in one Postgres database: accounts, organizations, the vault, the workers, and the fleet's live data it shows. Earlier versions kept accounts and the fleet in databases of their own. The move starts on an empty database: nothing is copied, people sign in again.

1. Create a Postgres database in the region of the app's functions. On Neon: a project in `aws-eu-central-1` for the `fra1` region that `packages/dashboard/vercel.json` sets (change one or the other so they match). Keep Neon's managed auth off: the app runs Better Auth itself.
2. On the deployment, set `ARMADA_DATABASE_URL` to the database's pooled connection string, and remove `ARMADA_AUTH_DATABASE_URL`, `ARMADA_AUTH_DATABASE_TOKEN` and the fleet database variables of earlier versions (the app reads none of them). Keep `ARMADA_AUTH_SECRET`, `ARMADA_AUTH_URL`, `ARMADA_AUTH_GITHUB_CLIENT_ID`, `ARMADA_AUTH_GITHUB_CLIENT_SECRET`, `ARMADA_AUTH_OWNER_EMAILS` and `ARMADA_SECRETS_KEY`. Set them before the deploy of step 3: a deployment of this version without `ARMADA_DATABASE_URL` fails closed (503) and names it.
3. Deploy. Optionally apply the schema first, from `packages/dashboard`: `ARMADA_DATABASE_URL=<direct, not pooled, URL> bun run db migrate`; otherwise the first request applies it.
4. Sign in with GitHub as an owner address and create the organization; invite the others again.
5. Enter the organization's keys again on Organization > Keys, and create new organization API keys for cloud coordinators: the old database's sessions, API keys and launch tokens do not carry over. Every terminal runs `armada login` again; a cloud coordinator gets its new key as `ARMADA_API_KEY`.
6. Register each project once: `armada init` from a signed-in terminal registers it for that terminal's organization, and so does the first claim, report or inbox read of a signed-in terminal. The first person running `init` becomes its owner. From `packages/dashboard`, `ARMADA_DATABASE_URL=<URL> bun run db register <path to the project's armada.toml>` registers one with no organization; it joins the first organization on the next dashboard read. This records the local username as owner; a service-account operator can add `--owner "Name"`. Later registrations preserve the first recorded owner.

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

A coordinator in Claude Code can also run short tickets as its own background subagents, each in its own git worktree: give those tickets a profile with `runtime = "claude-code"` and follow the `armada-runtime-claude-code` skill. They die with the coordinator's session. Use herdr for persistent local workers, or Conductor for cloud workers.

### Launch a persistent local worker

Install herdr 0.9.1 or newer and sign in to your chosen harness yourself. The coordinator must be signed in to Armada (`armada login`) so the worker receives a one-time launch token. Add a local profile to the project's committed `armada.toml`:

```toml
[herdr]
default_profile = "backend"

[herdr.profiles.backend]
harness = "codex" # claude, codex, opencode or deepseek (OpenCode + DeepSeek model)
model = "your-model-id"
effort = "high"
extra_args = ["--sandbox", "workspace-write"] # arguments for this harness only

[[herdr.routing]]
labels = ["api"]
profile = "backend"
```

Run `armada launch DEMO-13 --runtime herdr --harness codex`. The harness flag checks the selected profile; omit it to use the profile's harness. Routing follows the same rules as Conductor: first matching label, otherwise the default or sole profile. A profile with a plain-language `when` requires the coordinator to choose it with `--profile backend --reason "back end work"`; overriding a matching label rule also needs a reason. If the project has owner-validation rules, judge them with `--validation none` or `--validation <n> --validation-reason "<why>"` as with `armada brief`.

Launch checks herdr and the selected harness before creating a token or runtime. Missing or old tools can be installed only after explicit terminal consent; known missing sign-in blocks launch and Armada never runs login. `--json` never offers installs. The running CLI version must be published so the worker installs the same profile rules.

Launch starts a headless herdr server if none is running, creates the ticket branch's worktree from the repository's default branch, and creates a worker tab with inherited coordinator credentials cleared, closes the initial shell it created, and starts the harness in the returned worker pane. New servers receive only paths and runtime settings. Failure to close that initial shell stops launch. Model and effort are passed explicitly: Claude's `--effort`, Codex's `model_reasoning_effort`, and OpenCode's [model variant suffix](https://opencode.ai/v2/docs/models) (`provider/model#high`). `extra_args` are preserved as individual arguments. The complete brief reaches `herdr agent prompt` without shell interpolation; the token never appears in launch output or errors. New projects include the `Herdr` runtime label; existing projects need that value in their configured Linear runtime group before a worker can claim.

The worker signs in, claims with `--runtime herdr`, and starts its heartbeat. Its claim stores a JSON handle containing `workspace`, `pane` and `agent`, which `armada status` shows with its last report. Herdr keeps the worker's terminal running when the coordinator disconnects; the machine must remain awake. `--json` returns the launch handle and worktree path, without the prompt or token.

If startup or prompt delivery fails, launch retains the worktree for inspection. Run `herdr agent list`, inspect the returned handle, and cancel an unused token with `armada launch revoke DEMO-13` before retrying. Once claimed, use the worker release protocol. Never delete a retained worktree without checking for unpushed work.

For DeepSeek, add this profile (or choose another available DeepSeek model, such as `openrouter/deepseek/deepseek-chat` or `deepseek/deepseek-reasoner`):

```toml
[herdr.profiles.deepseek]
harness = "deepseek"
model = "opencode/deepseek-v4.1-flash"
effort = "high"
```

Select it explicitly when launching alongside other profiles:

```sh
armada launch DEMO-13 --runtime herdr --profile deepseek --reason "DeepSeek worker" --harness deepseek
```

`--harness` checks the selected profile; it does not change routing. The worker is **deepseek (OpenCode + DeepSeek model)**: Herdr starts its built-in `opencode` kind, with a persistent session that receives later plan approvals and answers. OpenCode discovers the worktree's `.agents/skills`. Launch, the brief, claim and status explicitly name this fallback; launch JSON keeps `harness: "deepseek"` and adds `actualHarness: "opencode"` and `harnessDescription`.

Doctor and launch check that each profile's exact model ID appears in the read-only `opencode models` output. DeepSeek models may be served by OpenCode Zen (`opencode/deepseek-v4.1-flash`), OpenRouter (`openrouter/deepseek/deepseek-chat`), or another provider; a `deepseek/` prefix is not required. When the model is missing or unavailable, interactive `armada doctor` and launch preflight ask the owner to choose a numbered model from `opencode models` (filtered to DeepSeek models for `harness = "deepseek"`). The chosen exact ID is saved in the profile in `armada.toml`, preserving formatting and comments, and the command reports the line written. Before starting an OpenCode-based worker, launch copies this configuration into its new worktree so the worker claims with the same profile and model, even when the coordinator’s config change is uncommitted. Without a TTY, with `--json`, or in CI, Armada changes nothing and shows the matching IDs and the config lines to add. The repository’s own DeepSeek profile uses the owner-selected `opencode/deepseek-v4.1-flash`. If no suitable models are available, the owner runs `opencode`, then `/connect`, or selects a DeepSeek model listed by `opencode models`. Armada never runs sign-in, reads provider credentials or handles the key. Missing OpenCode uses the existing explicit-consent install offer. Doctor reports dsh's presence/version as information only; missing dsh never prevents launch or produces an install offer, and no dsh-herdr plugin is installed.

Native dsh is parked in [THE-949 — revisit native dsh when it can resume](https://linear.app/thevibecompany/issue/THE-949). The inspected npm package `@deepseek-ai/dsh@0.1.5-rc.2` can read `.agents/skills` and run a task headlessly, but its headless runner creates a fresh agent, accepts one task, prints the answer and exits. It exposes neither follow-up input nor `--resume`, and its shipped profiles have no TUI. A worker that ends its turn to await a plan approval or an answer cannot receive the reply through that mode. Native dsh can replace the fallback once it provides an interactive or resumable headless session that supports those replies; no dsh version is installed or launched by this fallback.


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
- `armada brief <ticket> --prompt --profile-line` shows `Launch: no launch token (…)` on stderr: the reason says what to fix, usually the sign-in (`armada login`, or `ARMADA_API_KEY`). Human and JSON previews intentionally mint nothing. Cancel an unused or exchanged-but-unclaimed launch with `armada launch revoke <ticket>`; a claimed worker needs `armada release` instead. An unused token expired more than an hour ago clears server-side with one `not started (token expired)` inbox notice. Exchanged launches without a claim stop being followed after 24 hours. A worker whose token was refused or who was cut off gets a new prompt's `armada login --launch-token` line, as the runtime guide says.
- `armada inbox` needs a sign-in to Armada; without one, questions, plans and hand-backs are on the tickets only, and `armada status` still reads the fleet from Linear. Approve or amend each `plan` from the inbox, deliver the decision through the runtime guide, then record it with `armada answer <item> "<decision>"`. Pre-approved plans go straight to `implementing`: set `[policy] plans = "pre-approved"` in `armada.toml` (or label a ticket `plan-approved`) and every brief tells its worker so. What every worker must know (checks to run, generated files, how to bring main in) goes once in the file `[brief] extra` names.
- A Claude Code coordinator is refused the end of its turn by the stop hook: workers are in flight and no `armada watch` runs in its checkout. Start `armada watch` in the background; once nothing is in flight it exits "nothing to watch" and the hook lets the turn end. If the hook itself misbehaves, set `ARMADA_STOP_HOOK=off` in the coordinator's environment and report it.
- `conductor` exits 3: check `conductor auth whoami`. A command refused by your `conductor` version: compare with `conductor <command> --help`; the runtime guide names the versions it was checked against.
- A fact the coordinator could not find in the repository, the tracker or Armada: add it to the skill or to this runbook in a pull request, so the next coordinator finds it.

Local worker controls follow the [`armada-runtime-herdr`](../skills/armada-runtime-herdr/SKILL.md) guide. `armada status`, `inbox` and each `watch` poll read herdr state and store it on Armada; the dashboard shows it beside the last report without contacting the local machine. `armada answer` delivers herdr answers before recording them, including a harness approval answered by ticket. After merge or release, `armada stop <ticket>` verifies the saved worktree, refreshes its remote upstream, refuses dirty or unpushed work, and removes only the clean checkout while retaining the branch. Worker reports, questions and heartbeats also self-report their phase to herdr, with nonfatal warnings on failure.
