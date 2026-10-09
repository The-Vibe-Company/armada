# Runbook: start a coordinator

## Upgrade an existing project

For a project on 0.2.55, install the current CLI with `npm install -g @the-vibe-company/armada` and confirm `armada --version`. Self-hosted installations deploy the current dashboard and its additive migrations first; hosted Armada handles that step.

1. Sign in with `armada login`, run `armada doctor`, then `armada init` from the checkout. Review and merge its one setup PR (skills, links, setup scripts and labels). Init preserves an existing `armada.toml`; add the optional examples below yourself. If it reports setup is current, no PR is needed.
2. Configure `[[deploy.target]]` with exactly one live source (`github_environment`, `live_sha_command` or `check`) and an optional `smoke` command ([deployment example](#check-deployments-after-merges)). Add known flakes as `[[ci.known_failure]]` with an exact `check`, regex `pattern` and root-cause `ticket`; `armada ci why <pr> --rerun` only retries eligible first-attempt failures once.
3. Review `[merge] notify_paths` for shared files, `[[acceptance]]` for live pre-hand-back checks and `[jobs.<name>]` for surviving runners. Tune `[policy] plans`, `pre_approved_label`, `approval_label`, `silence_minutes`, `launch_grace_minutes` and `ci_wait_minutes`; use `merge_approval` or `[[policy.validation]]` for owner decisions. Defaults keep old projects working; doctor’s optional lines are informational.
4. Open Organization > Notifications as an owner/admin, set the webhook and send a test. Choose language, time zone, quiet hours and digest times/days ([owner alerts](#get-owner-alerts-in-chat)); these are dashboard settings, not TOML sections. Production cron stays off unless you explicitly configure it.
5. Name each coordinator with `armada coordinator use backend` (or `ARMADA_COORDINATOR=backend` in its cloud environment). Check `armada coordinator list`; [handover](#run-a-second-coordinator) explicitly assigns existing tickets.
6. Use `armada launch ABC-12 --runtime conductor` to launch cloud workers, replacing the runtime guide’s manual create/bind/token steps. Configure `[conductor] project_id` or `base_branch` only when repository/default-branch discovery needs an override. Run `armada doctor` again and check the fleet with `armada status`.

For queued merges, set `[merge] queue_retest = "ci"` to update queued branches and wait for fresh CI, or `"local"` to use `[gates] local_commands`. Queue intent with `armada merge --when-green <pr...>`. Check `armada merge --help` before enabling the drain setting on an older CLI.

## Rerun CI with a dependent summary check

`armada ci why <pr> --rerun` ignores an aggregate failure only when job steps and complete logs prove a dedicated dependency-reporting gate. The gate must be the job's only executed user step, with only skipped user steps besides GitHub's successful setup and completion steps. Its sole logged command block must contain only literal `echo "Dependency failed: <check name>"` commands followed by `exit 1`, with matching output and the usual exit-code annotation. Check summaries and annotations may only contain that exit-code notice. Each named failed check must be known (or a runner problem) in the same workflow run and commit. For example:

```yaml
verify:
  needs: [tests]
  if: failure()
  runs-on: ubuntu-latest
  steps:
    - name: Check dependencies
      run: |
        echo "Dependency failed: Tests (linux)"
        exit 1
```

Use the dependency's displayed check name, including matrix suffixes. The output labels `verify` as "ignored as a dependent summary" and names the real flake's root-cause ticket. A summary with its own failed command, test, extra error or another failed step remains unknown. Unrecognized summary scripts and missing step/log evidence also remain unknown; merely naming a job `verify` never permits a rerun. The run must still be completed on attempt 1, with an unchanged failure set, and can be rerun only once.

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
- **No runtime holds a fleet key.** A signed-in coordinator gets the organization's Linear key from Armada on each command, and each worker gets a one-time launch token in its launch message: its first authenticated command, `armada login --launch-token`, exchanges it for a session limited to its ticket, through which Armada gives it the Linear key. No machine holds a database key: claims, reports, questions, the inbox, the merge lock and the project registry go through the Armada API with the sign-in. Conductor's organization environment holds no Armada key: not `LINEAR_API_KEY`, and not `ARMADA_API_KEY` either, since every workspace starts with that environment and a worker would then act with the coordinator's rights.
- **Secrets workers need to build and test** (an LLM provider key, a test database URL) are kept per project in Armada, not in Conductor's environment: the coordinator moves each one with `armada secrets set <NAME> --from-env <NAME>` (owner or admin), and workers run their tests with `armada run -- <command>`. List the names in `[secrets] names` of `armada.toml` so `armada doctor` says which are missing.
- **Environment variables stay an override**, for CI and for an Armada without accounts (self-hosting): a key set in the environment wins over Armada's. Until the organization's keys are on the Keys page, keys in Conductor's organization environment keep a fleet running as before (the runtime guide's launch with keys).
- **The dashboard** (optional) is deployed with `ARMADA_DATABASE_URL`, the accounts variables and `ARMADA_SECRETS_KEY`, as the README's "Watch the fleet" section describes. It never needs a runtime key.
- **The coordination ticket** (optional): when a run has a goal of its own ("run this ticket end to end", "ship this spec"), create a ticket for it. The coordinator claims it, reports on it and hands over through it.

Never paste a key into a prompt, a ticket, a file in the repository or a chat. A launch token is the one exception, made for it: it works once, within the hour, for one ticket.

## Move the keys out of Conductor

For a fleet that ran with the keys in Conductor's organization environment:

1. Enter the keys on Armada's Keys page (Organization > Keys), and create an organization API key for cloud coordinators (Organization page).
2. Check from a terminal with none of the keys in its environment: `armada login`, then `armada doctor` says `signed in to <Armada> as <you>, <organization>`, and `armada auth status` shows each key from `Armada: …`. `armada brief <ticket>` and `--json` are read-only: they show `Launch: a one-time token is made when you print the prompt (--prompt)`, without a token or a launch row. Launch Conductor or herdr with `armada launch <ticket> --runtime conductor|herdr`; use `armada brief <ticket> --prompt` for guided Claude Code launches.
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

## Run a second coordinator

A coordinator is a named role inside one project, independent of its machine or session.
Set `ARMADA_COORDINATOR=front` for a cloud coordinator, or run `armada coordinator use front`
to remember the role for this project and checkout. The environment wins over that preference;
without either, the role is `default`. Names use 1–32 lowercase letters, digits or hyphens,
starting with a letter or digit.

`armada coordinator list` shows each role's sessions, last-seen times and tickets. A launch
records the role in its authenticated launch token; a worker's claim inherits it, and cannot
choose a different owner. Workers launched before this migration stay unowned until taken.
Each role's `armada watch` has its own lock and memory on the machine and follows its owned
and unowned work. `armada watch --stop` stops that role's watch; `--stop --name front` stops
front's verified watch without stopping another role.

To take over a stopped coordinator's tickets, choose your role and run
`armada coordinator take ABC-12 ABC-13 --from front`. The source ownership must still match
for every ticket: a concurrent handover refuses the entire take. The handover records an
event, keeps the worker generation and phase, and its next inbox read follows the new owner.
Pass the role name in any coordinator handover comment, along with the tickets and next actions.
Deploy the dashboard migration before installing the new CLI.

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

1. Create a secret for GitHub (`openssl rand -hex 32`). On the GitHub App's settings, turn the webhook on: URL `<dashboard>/api/webhooks/github`, that secret; Permissions & events > Subscribe to events: Pull request, Check suite, Check run, Status, Push (refreshes the default branch before CI starts).
   Main CI failures use those Check suite, Check run and Status deliveries to open a shared `main-red` merge pause and wake `armada watch` once per red streak. Push is optional for detecting the failure, but refreshes main before CI starts. A green reading clears the pause and its inbox item; running or absent checks keep it. Merge a fix with `armada merge <pr> --through-hold "<why this fixes it>"`. Without webhooks, detection waits for a stale reading to refresh after a dashboard view; if no refresh runs, no automatic pause opens.
2. In Linear, Settings > API > Webhooks: a new webhook to `<dashboard>/api/webhooks/linear` for Issues, Comments, Issue attachments and Issue labels. Copy its signing secret.
3. On the deployment, set `ARMADA_GITHUB_WEBHOOK_SECRET` and `ARMADA_LINEAR_WEBHOOK_SECRET`, and redeploy.
4. Check: GitHub's Recent Deliveries and Linear's webhook page show answers 202. Change a ticket's label or push to a pull request: the Fleet view shows it within about ten seconds, and the top bar's "Linear and GitHub read … ago" resets.

No cron is needed: nothing reads Linear or GitHub on a timer, so the database can scale to zero when nobody looks.

## Get owner alerts in chat

1. Deploy with accounts and `ARMADA_SECRETS_KEY`. An owner or admin opens Organization > Notifications.
2. Paste a public HTTPS webhook, choose Slack-compatible text or signed JSON, and optionally filter to a project. For JSON, enter a signing secret of at least 16 characters that the receiver shares; verify the exact body with HMAC-SHA256 and the `x-armada-signature: sha256=…` header.
3. Choose language (initially `[tracker] language`), time zone and quiet hours, save, then **Send a test**. The page shows who set it, when, and the last delivery state; neither the address nor the signing secret returns to the page. Leave those fields blank on later saves to preserve them.
4. Check that a merge approval, work validation or escalated question sends its `/approve/<id>` link once. A coordinator that stops while its inbox waits sends an alert; it sends another only after returning and stopping again. Quiet-hour alerts are stored for the next summary.
5. Choose digest times and days (09:00, 13:00 and 18:00 weekdays by default), and optionally **Skip quiet digests**. Times use the channel’s time zone, including DST; clear the times to disable them. A slot over 30 minutes late is skipped and noted in the next digest. Summaries list recent deployments and persistent deploy failures, running and recently ended long jobs with progress and estimated ends, and tickets grouped by spec with done/total counts when several groups appear.
6. Ask the coordinator to run `armada digest` for a status update, `armada digest --since 4h` for a fixed window, or `armada digest --send` to post it. Language follows `[tracker] language` unless `--lang en|fr` overrides it; the channel has its own language setting. The CLI gets no webhook address.
7. On a paused channel, correct the endpoint and save to resume. HTTP 404/410 pause immediately; ten consecutive delivery failures pause too. Each failed alert is tried at most five times, at least a minute apart. Delivery errors are fixed codes, never provider response text.

Cron is **off in production by default**, as the owner decided. Ticks ride on fleet traffic and dashboard polls, with a 60-second lease scoped to each project. With no traffic, a stopped coordinator is only noticed at the next call or poll. To opt into a scheduler, set `CRON_SECRET`, configure an authenticated GET to `/api/cron/owner`, and follow README > Watch the fleet for the Vercel `crons` entry (every 15 minutes requires a paid plan; free allows daily). Do not enable it as part of the default deployment. A tick reads stored snapshots and live rows only; it never calls Linear or GitHub.

## Start a coordinator on a laptop

1. Install Armada (Node.js 22 or later) and sign in. `armada doctor` checks the repository and the sign-in; `armada auth status` shows where each key comes from, never a value.

   ```sh
   npm install -g @the-vibe-company/armada
   armada login          # once per machine: approve the code in the browser
   armada doctor
   gh auth status
   conductor auth whoami
   ```

2. Open a checkout of the repository on its default branch, up to date, and start your agent there (for example `claude` or `codex`). The skills are in `.agents/skills`, linked from `.claude/skills`. The five `armada-*` entries are discovery pointers: run `armada skill armada-coordinator` and follow its output; read linked files with `armada skill armada-coordinator MERGE.md`. Instructions follow the installed CLI version, so instruction-only releases require no setup PR. Install the version named in a worker brief before running `armada skill armada-worker`. The shipping, review and learning packages remain vendored because they include scripts. Run `armada init` once to convert older full copies, then only when doctor flags changed pointer descriptions or vendored packages.
3. Give it the launch prompt below. Its handle is one you choose and that names the session, for example `coordinator-<your name>-laptop`, and its runtime is the one it runs in (`claude-code`, `codex`).

The laptop must stay awake and online while the coordinator runs: when it sleeps, nobody answers the workers. For a long run, start the coordinator in Conductor Cloud instead.

Workers launched from a laptop need no key either: the brief's prompt carries their launch token.

A coordinator in Claude Code can also run short tickets as its own background subagents, each in its own git worktree: give those tickets a profile with `runtime = "claude-code"` and follow the `armada-runtime-claude-code` skill. They die with the coordinator's session. Use herdr for persistent local workers, or Conductor for cloud workers.

### Follow fleet events

Plain `armada watch` remains the default for agents woken when a background command ends. In a terminal, herdr pane or harness that delivers every output line, `armada watch --follow --for 50` prints events continuously, ends cleanly below a harness's time limit and prints its resume command. A restarted follow uses this machine's last cursor and printed inbox keys; `--since <cursor>` carries the event position to another machine, where open inbox entries are shown once as `open`.

Use `--tickets ABC-1,ABC-2 --kinds hand-back` for selected hand-backs; `--kinds all` includes informational claims, reports, releases and merges. `--json` produces NDJSON; lifecycle, retry and resume lines go to stderr. Without informational kinds, active follow makes one short inbox request every 15 seconds (60 seconds idle), answered 304 when unchanged. Informational kinds add a short `events/since` read, paged at 200 events with a two-minute look-back and a 500-ID deduplication window. `--mine` needs "Show each coordinator only its own work" and is refused until then. Plain watch accepts `--for <minutes>` too. Use `armada watch --stop` to stop either mode; they share the existing project lock.

Ordinary Armada releases do not stop either watch. `armada status` and `armada inbox` announce an update at most once per 24 hours on the machine; the coordinator card also shows availability. A required server minimum or differing installed pointer descriptions/vendored skills produces a `version` item and stops the watch, including filtered follow. Run `armada upgrade` from the project's checkout: it checks npm availability up to five times (four 30-second waits), installs the exact target, verifies the executable on PATH, then checks setup with the installed doctor. It runs `armada init --merge` only when setup is behind; that command waits for the normal setup PR checks. Publication/install/version-check failures leave setup alone. Workers keep their launch's pinned version.


### Launch a Conductor worker

Sign in to Armada, then run `armada launch <ticket> --runtime conductor`. The routed profile supplies the agent, model, effort and fast mode; use `--profile <name> --reason "<why>"` for a coordinator’s choice. `--notes notes.md` adds context from a file relative to the current folder (`--notes -` reads stdin); missing, empty or larger-than-16-KB notes are refused before making a token. Notes do not change plan approval. The command prints the ticket, profile, workspace/session ids and session link; its brief and one-time sign-in travel only through stdin.

`--dry-run` shows settings, the command and preflight without launching. An optional `[conductor] project_id` selects the explicit Conductor project rather than the configured GitHub repository; `base_branch` overrides origin’s default. Runtime can be omitted when the chosen profile decides it. Claude Code profiles instead point to `armada brief <ticket> --prompt` and the Agent tool.

Active claims, pending launches and another launch holding the ticket’s lease are refused. Known Conductor failures revoke the exact pending launch; uncertain create results are searched without retrying. Recovery checks stable repository, creation time and session ids, so renamed workspaces or sessions remain discoverable. An ambiguous or incomplete search retains the pending launch and prints visible candidate ids and inspection commands; inspect them, then bind or revoke the pending launch and archive unwanted workspaces before launching again. An unavailable bind route warns and leaves the worker running; its sign-in records the handle. Check the claim with `armada status`.

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

To check routing and the machine first, run `armada launch DEMO-13 --runtime herdr --dry-run` (add `--json` for the same plan as JSON). It prints the chosen profile and why, the harness and its exact model, the branch and the worktree path herdr would create, and the preflight result, then exits 0 when the preflight passes and non-zero, listing every gap, when it does not. It is read-only: no worktree, token, pane or install, and no config write.

Launch starts a headless herdr server if none is running, creates the ticket branch's worktree from the repository's default branch, and creates a worker tab with inherited coordinator credentials cleared, closes the initial shell it created, and starts the harness in the returned worker pane. New servers receive only paths and runtime settings. Failure to close that initial shell stops launch. Model and effort are passed explicitly: Claude's `--effort`, Codex's `model_reasoning_effort`, while OpenCode receives the exact provider/model ID with no effort suffix (its TUI currently has no CLI effort flag). `extra_args` are preserved as individual arguments. The complete brief reaches `herdr agent prompt` without shell interpolation; the token never appears in launch output or errors. New projects include the `Herdr` runtime label; existing projects need that value in their configured Linear runtime group before a worker can claim.

The worker signs in, claims with `--runtime herdr`, and starts its heartbeat. Its claim stores a JSON handle containing `workspace`, `pane` and `agent`, which `armada status` shows with its last report. Herdr keeps the worker's terminal running when the coordinator disconnects; the machine must remain awake. `--json` returns the launch handle and worktree path, without the prompt or token.

Before the first local launch, the owner runs `armada setup local` at an interactive terminal. It asks once for `ask` or `full` on profiles that have no saved permission choice (Enter selects `ask`), saves the choice in `armada.toml`, and opens a dedicated herdr setup workspace with one pane per native harness used by the profiles. OpenCode and DeepSeek share an OpenCode pane; setup uses the first configured profile of each native harness and prints its name. The owner attaches with each printed `herdr agent attach <name>` command and answers folder trust, updates, project MCP, sign-in and model questions themselves. Press Enter back in setup to check again. For OpenCode, setup verifies the exact selected profile model from its prompt footer after first-run questions are cleared; a fallback model stops the check and retains the pane. Only after the pane is ready does Armada send a token-free “OK only” model check. A Codex ChatGPT-account model rejection is shown as a model problem; update that profile's model in `armada.toml`, then start a fresh setup pane with it. Setup keeps its panes available; rerunning reuses their current sessions, and checks a saved fingerprint of their launch settings. After changing a model or permission choice, setup refuses the stale session: close that harness's setup pane yourself and rerun to start the new configuration. Setup makes no launch token or claim and needs no Armada sign-in. Noninteractive, CI and `--json` report the interactive-terminal requirement without starting sessions or changing permissions. Doctor points to this setup; its binary/credential checks alone do not prove a model can answer.

Setup learns herdr's actual worktree parent through a dedicated checkout on `armada-local-setup-<project-slug>` (from local `HEAD`), then starts the harness panes at that parent, including custom `worktrees.directory` paths. The setup checkout and its sanitised shell are retained; it is never a worker ticket. Reserve that branch for setup. After changing herdr's worktree directory, safely remove that setup checkout with herdr after checking it is clean, then rerun setup so the new parent is discovered.

Trust at the parent is not a blanket repository approval. [Current Claude Code documentation](https://code.claude.com/docs/en/permissions#workspace-trust) says parent trust excludes child Git repositories and linked-worktree trust is keyed on the main checkout root. [Claude Code v2.1.232](https://github.com/anthropics/claude-code/releases/tag/v2.1.232) stopped nested repositories inheriting parent trust. The owner should approve the main repository themselves; installed versions that still prompt for each new worktree need an answer there once. Project MCP questions can also recur per checkout. Armada never sends trust/MCP answers, changes harness trust/settings files, or enables a project MCP server. Failed-launch cleanup revokes only the launch it created. An older dashboard that lacks this scoped cleanup route safely refuses it; Armada prints manual recovery guidance instead of revoking another pending launch. Deploy the updated dashboard before using automatic cleanup.

Each local profile accepts `permissions = "ask" | "full"`. Omitted permissions behaves like `ask`: Armada adds no bypass flag, and the harness's own settings and any explicit `extra_args` remain in effect. `full` adds Claude's `--dangerously-skip-permissions`, Codex's `--dangerously-bypass-approvals-and-sandbox`, or OpenCode/DeepSeek's `--auto`; OpenCode still enforces explicit deny rules. Codex full also removes its command sandbox. This is the owner's choice, never a silent default for a new project. Legacy explicit flags in `extra_args` still work without the new key; `full` deduplicates its matching native flag, and explicit `ask` conflicts with that flag. Setup choosing `ask` removes that legacy native bypass flag while preserving unrelated arguments. `full` controls tool approvals; any first-run question still present must be answered by the owner. Codex launch disables its startup update check with `-c check_for_update_on_startup=false` unless `extra_args` explicitly overrides that setting.

If startup or prompt delivery fails, launch retains the worktree and attempts to revoke the pending token automatically. Known Claude trust/MCP and Codex trust/update/account-model screens produce a named question with `armada setup local` and the exact `herdr agent attach <name>` command, instead of a bare runtime error. An unknown blocked screen also names the attach command. If revocation fails, launch says to run `armada launch revoke DEMO-13` before retrying; once claimed, use the worker release protocol. Never delete a retained worktree without checking for unpushed work.

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
- `armada inbox` needs a sign-in to Armada; without one, questions, plans and hand-backs are on the tickets only, and `armada status` still reads the fleet from Linear. Approve or amend each `plan` from the inbox with `armada answer <item> "<decision>"`: it delivers to herdr and Conductor before recording. For Claude Code, deliver through the runtime guide first. Pre-approved plans go straight to `implementing`: set `[policy] plans = "pre-approved"` in `armada.toml` (or label a ticket `plan-approved`) and every brief tells its worker so. What every worker must know (checks to run, generated files, how to bring main in) goes once in the file `[brief] extra` names.
- A Claude Code coordinator is refused the end of its turn by the stop hook: workers are in flight and no `armada watch` runs in its checkout. Start `armada watch` in the background; once nothing is in flight it exits "nothing to watch" and the hook lets the turn end. If the hook itself misbehaves, set `ARMADA_STOP_HOOK=off` in the coordinator's environment and report it.
- `conductor` exits 3: check `conductor auth whoami`. A command refused by your `conductor` version: compare with `conductor <command> --help`; the runtime guide names the versions it was checked against.
- A fact the coordinator could not find in the repository, the tracker or Armada: add it to the skill or to this runbook in a pull request, so the next coordinator finds it.

Local worker controls follow the [`armada-runtime-herdr`](../skills/armada-runtime-herdr/SKILL.md) guide. `armada status`, `inbox` and each `watch` poll read herdr state and store it on Armada; the dashboard shows it beside the last report without contacting the local machine. `armada answer` delivers herdr and Conductor answers and notes before recording them, including a herdr harness approval answered by ticket. Conductor retries use a stable message id; rerun the same command after a recording failure. After merge or release, `armada stop <ticket>` verifies the saved worktree, refreshes its remote upstream, refuses dirty or unpushed work, and removes only the clean checkout while retaining the branch. Worker reports, questions and heartbeats also self-report their phase to herdr, with nonfatal warnings on failure.

### Launch when blockers close

A coordinator can schedule a blocked ticket with `armada launch ABC-9 --when-unblocked --profile backend`. Armada stores a signed launch request and prints the open blockers. `armada status` lists it under **Launch when unblocked**, including its current blockers or a reason such as parked. `--after ABC-7` asserts that ABC-7 is already a blocker in Linear; it does not create a relation. Every blocker must close, including blockers canceled rather than completed. An unblocked ticket is refused with the ordinary launch command.

After `armada merge` closes a blocker, ready deferred tickets launch through the shared launcher in the same command. Automatic launches require a stored project reading and the same authenticated author that requested them (the person or organization API key). Requests from another author remain for their coordinator. Guided Claude Code profiles and tickets without the ready label print the launch command for the coordinator to handle. A parked ticket stays pending; remove its parked label before launching it.

When blockers close outside Armada, Linear's webhook refreshes the stored reading and `armada watch` wakes with the request's launch command. Keep the watch armed while a deferred request waits. No inbox poll calls Linear. Missing readings withhold requests until a stored reading is available. The worker's claim resolves the request; a failed launch keeps it pending for inspection. To decline one, run `armada answer <request-id> "<reason>"`.

Deploy the dashboard's additive deferred-request migration before using the new CLI options. Older clients continue reading the ordinary inbox kind; the new request and status operations require the updated dashboard.

Workers declare planned paths with `armada report awaiting-approval --plan-file plan.md --paths "src/merge.ts,skills/**"` (or `implementing` for a pre-approved plan). The CLI and coordinator plan show overlaps with other in-flight PR files and declared paths. Briefs list the first 15 PR files and the remaining count. An incomplete or unavailable stored GitHub reading is explicitly marked; refresh the project reading before relying on it. Glob/glob matches use conservative static prefixes and may overlap. GitHub records only the new path of a rename; overlap checks can miss its old path. Declarations are replaced when supplied again and cleared on release or merge.

## Check deployments after merges

The owner declares each deployment target in `armada.toml`. Use a GitHub deployment environment when the host reports deployment statuses, or a `check` command that reports the host’s outcome. Choose exactly one of `github_environment`, `live_sha_command` or `check`:

```toml
[[deploy.target]]
name = "api"
branch = "main"                         # optional: default is the merged PR's base
# Exactly one live source:
github_environment = "production"
# check = "./scripts/check-deploy.sh"
# live_sha_command = "curl -fsS https://example.test/version"
smoke = "curl -fsS https://example.test/health" # optional: exit 0 is healthy
timeout_minutes = 20                    # 1 to 120
pause_on_failure = true                 # false keeps the inbox warning without a hold
```

A `check` command exits **0** when the requested commit is live, **1** only when the host confirms that deployment failed, and **2** while pending or on a network/read error. To report a host skip, exit 2 with the last stdout line `skipped: <reason>`, for example `skipped: no files of this service changed`. It ends quietly as **not deployed (host skipped: …)**: no hold, inbox item or smoke run, and the watcher exits 0. A later observation of that SHA can replace it; it never covers ancestors or clears their failures.

Example script shape (replace the host commands with your project's adapter):

```sh
#!/bin/sh
outcome=$(hosting-cli deploy-state "$ARMADA_DEPLOY_SHA") || exit 2
case "$outcome" in
  live) exit 0 ;;
  failed) hosting-cli deploy-log "$ARMADA_DEPLOY_SHA"; exit 1 ;;
  skipped) printf '%s\n' 'skipped: no files of this service changed'; exit 2 ;;
  *) exit 2 ;;
esac
```

Exit 0 or 1 may end stdout with a full 40-hex SHA; otherwise Armada uses `ARMADA_DEPLOY_SHA`. A different SHA must contain the watched commit, or the watcher keeps waiting. Failed checks pause merges on the first poll, retaining the last output lines. A timed-out check, an output-limit termination or an unknown exit code keeps waiting; the deadline reports why. Configuration failures still take precedence. Legacy `live_sha_command` keeps its semantics: failed commands wait until timeout, and host skips become pauses. `armada doctor` explains that limitation and warns for every target without `smoke`. Merge's watching line also warns: without smoke, a live but broken service reads healthy. These checks run only after merges, not as periodic service monitoring.

Self-hosted installations must deploy dashboard/API migration **45** before using the new CLI or `check`; downgrade the CLI before removing support for `not-deployed`.

For a machine-specific linked folder, declare `requires_env = ["DEPLOY_LINK_DIR"]` and reference `$DEPLOY_LINK_DIR` in the live and smoke commands. From the project checkout, run `armada config set deploy.env.DEPLOY_LINK_DIR /path/to/linked-service` once on each coordinator machine. Values live under the user's Armada config directory, per project, and win over the process environment. `armada config unset deploy.env.DEPLOY_LINK_DIR` restores environment fallback. `armada doctor` lists missing names and the exact fixes. An unconfigured target warns once and records a skipped deploy without a hold; after configuring it, retry `armada deploy watch --sha <sha> --target <name>`. A command that cannot run on this machine (exit 127, an unset-variable guard or a missing linked directory) warns once and records a **not runnable (configuration)** deploy notice without opening a hold. Fix the local setting or tool, then retry the same watch command with a fresh deadline. Runnable deploy and smoke failures still hold.

After a confirmed merge, the CLI starts a detached watcher per configured matching target and returns. Each watcher checks every 30 seconds until the merged commit or a descendant is live, then runs smoke. Check, live SHA and smoke commands run with `sh -c` in the repository root, with the resolved machine-local `requires_env` settings, `ARMADA_DEPLOY_SHA` and `ARMADA_DEPLOY_TARGET` set. Merge startup passes the same resolved environment, including the machine config root, to the detached watcher. Commands are bounded to one minute and the remaining deploy deadline. For project secrets, declare the command as `armada run -- <command>`; the watcher never fetches secrets itself. GitHub ancestry reads need the terminal's GitHub token; command-only targets can also use commits already available in the local checkout.

A failed deployment, smoke failure or timeout opens one coordinator inbox item and, by default, a target's deploy hold. Inspect `armada deploy status` or `armada status`. Merge the repair with `armada merge <pr> --through-hold "<what this repairs>"`; a later healthy deploy automatically clears covered failures and their target hold. Other targets and manual holds remain independent. Output detail keeps the last 30 lines, capped at 4 KiB. No deployment comments are added to Linear. Self-hosted installations must deploy the dashboard/API with migration 42 before using a CLI that records `not-runnable`; downgrade the CLI before removing support for that state.

If detaching is unavailable, the merge prints the explicit `armada deploy watch --sha <sha> --target <name> --config <path>` command. Run it in a persistent terminal. Waiting records retain their start time; status and the next merge flag watchers without recent news. Restart the same command to continue the original deadline. Detached watcher logs are under the machine's Armada `watch/` directory as `deploy-<id>.log`. Projects without deploy targets keep their existing merge behavior.

## Track a long job on a surviving runner

Long runs go through `armada job`, never in a coordinator or worker terminal session. The project owns the runner (a CI run, VM, cloud workspace or another service) and its secrets. Armada stores its reference and last observation in Postgres; the server never executes project code. A new machine signed in to the same project can read the same jobs.

Declare commands in `armada.toml`:

```toml
[jobs.eval]
start = "./scripts/start-eval.sh"
status = "./scripts/job-status.sh"
stop = "./scripts/stop-eval.sh"
silence_minutes = 15
max_hours = 12
```

The CLI executes each with `sh -c` in the directory containing `armada.toml`. It sets `ARMADA_JOB_ID` (the durable job id), `ARMADA_JOB_REF` (empty for start), `ARMADA_TICKET` and `ARMADA_PROJECT`. Commands inherit the terminal environment. Use `armada run -- armada job ...` when the runner command needs the project's secrets.

The start command must dispatch to a runner that survives the terminal and return within two minutes. Its last nonblank stdout line is the runner's reference (run id or URL); a nonzero exit means not started. Armada reserves a `starting` record first so the command can attach the job id to its run. A successful dispatch becomes `running`; a failed dispatch becomes `failed`. A timeout or execution failure whose outcome is unknown becomes `lost`: inspect the runner before dispatching again. A command whose result cannot be recorded prints the job id and runner reference for recovery; it is never retried automatically.

The status command's last nonblank line is `running`, `succeeded` or `failed`, optionally followed by progress text. `running 37/120 cases` produces an approximate completion time from the elapsed time and fraction. Unparseable output or a failed poll leaves the last observation intact. Omit `status` for a runner that pushes its own observations. Stop's exit code zero means stopped. Status and stop are also bounded to two minutes. The CLI captures output, displays only the runner reference and parsed progress, and never prints command stderr.

```sh
armada job start eval --ticket ABC-12
armada job status            # poll every open job on this project
armada job status 42         # poll one job; completed records are read only
armada job list              # read every stored job; never run a command
armada job list --ticket ABC-12
armada job stop 42
# After an observation outage, record the outcome without running a shell command:
armada job recover 42 --ref runner-123 --state running
```

Workers default to their claimed ticket and can start, observe and read only that ticket's jobs. Other terminals use their organization sign-in. All commands accept `--json`; list/status output is an array of job records. `armada status` reads open jobs without running status commands and includes their latest progress, runner reference and ETA. An open job past `max_hours` is overdue, and a job whose Linear ticket is Done carries a note. Neither condition automatically stops it. A running job without news for longer than `silence_minutes` appears in `armada inbox` as `job-silent`. The server derives that alarm when the inbox is read, with no timer. A fresh observation clears it. The coordinator's `armada watch` runs configured status commands at most once per half the silence interval, retaining the last observation when a probe fails. Open jobs keep watch alive even after their ticket or worker ends; silence never stops them.

The first observation of `succeeded`, `failed`, `stopped` or `lost` stores one `job` inbox notice naming the job, ticket, outcome and last progress. Watch wakes once for that notice; acknowledge it with `armada answer <item-id> "Runner outcome checked"`. Repeated final observations never create another notice.

To push news from the runner, create an organization API key in Armada and set it as the runner's `ARMADA_API_KEY` secret. Give the runner a copy of the project's `armada.toml` (or pass `--config`) and the job id supplied to the start command. Set `ARMADA_API_URL` when using a different Armada deployment. The key has organization scope in V1; a job-scoped token is a later feature. Never put the key in code, command arguments or logs.

```sh
# ARMADA_API_KEY is provided by the runner's secret store:
armada login --api-key
armada job beat "$ARMADA_JOB_ID" --progress "40/120"
# Send a terminal state when the run ends:
armada job beat "$ARMADA_JOB_ID" --state succeeded --progress "120/120"
```

Beat calls the existing project-scoped observation API without executing a runner command or fetching Linear/GitHub keys. Its default state is `running`; `--state` also accepts `failed`, `stopped` and `lost`. Omit progress to retain the last reported value. News becomes visible on the dashboard's next Postgres read. A slow coordinator probe cannot overwrite a newer pushed observation: a monotonic job revision fences it, even when the observations have equal timestamps. Deploy the dashboard (migration 38) before updating the CLI.

A successful start with no stdout reference is still recorded and shown with `no runner reference`; status and stop refuse to contact it. Find the existing run on the runner, then attach its reference with `armada job recover <id> --ref <reference>`. Recovery runs no shell command, keeps existing references fixed, and cannot change a terminal job's outcome. Use `--state failed`, `--state lost` or `--state stopped` to finalize a starting record after an observation outage when that outcome is known. Repair the runner's start command before dispatching another job. Closing a terminal never stops an already-dispatched runner.
