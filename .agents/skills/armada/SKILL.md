---
name: armada
description: Use Armada from a terminal to sign in, select an organization, choose a golden or template, schedule owner-scoped routines, launch Claude Code or Codex in Boat or Modal sandboxes, pin private skills, send or steer work, wait, inspect failures and preserve work. Use whenever someone asks to launch, monitor, troubleshoot or control Armada sandboxes, including several sandboxes from another sandbox. This is tool knowledge, not a project coordination, code review or merge policy.
---

# Armada terminal guide

The REST sandbox status route is `POST /api/v1/sandbox/status`.

Armada launches agents; you decide task ownership, acceptance criteria and budget.
Requires the Armada CLI and access to an Armada server. This skill ships with the
CLI source; check `armada --version` and `armada --help` before using a differently
versioned installation. Read the installed command's help rather than inventing
flags. Examples use placeholders such as GOLDEN, SANDBOX and ORG; substitute real
IDs, and quote prompts as single arguments.

Sandbox commands emit JSON when stdout is piped or redirected. On failure,
parse the final stderr line for `error.code`, `error.message`, and `error.hint`.
An explicit sandbox ID overrides `ARMADA_SANDBOX` and the local
`.armada/sandbox` file written by a successful `armada new` in that directory. Prefer explicit IDs in
coordinator scripts that manage several sandboxes from one directory. In JSON,
read `providerSandboxId` for provider display metadata and `providerSnapshotId`
for a golden's provider snapshot. Use the Armada `id` for sandbox commands.

## 1. Establish identity and scope

Run `armada info --setup --json` for identity, organization, server, GitHub,
hosts and model accounts. Use `armada org list` to find organization IDs.
For an interactive human, run `armada login` and authorize the request in the dashboard
using the printed link and matching short code. For automation, use an authorized
ARMADA_TOKEN through the environment, never pasted into a prompt or command.
ARMADA_URL selects the server; confirm it before any write. Do not inspect or
print token values. `armada login --org ORG` persists the selection for that server;
use explicit organization arguments in multi-org automation to avoid ambiguity.
`armada org setup` diagnoses provider setup. Missing membership or provider
access needs an authorized admin, not a retry loop.

Read [setup and configuration](references/setup.md) when connecting GitHub,
selecting model accounts, creating goldens/templates, or configuring variables.
Manage snapshots, templates, default skill pins, variables and application secrets through
the dashboard or the authenticated REST API. For template and vault administration through
`armada api`, see [setup](references/setup.md#templates-readable-variables-and-secrets).
Launch an existing template with
`armada template launch` or `POST /api/v1/templates/launch` and reuse its request key on retry.

Use the dashboard for organization creation, membership and invitations. In scripts,
use `armada api org/create`, `armada api members/...` and `armada api org/invitations/...`.
Supply the organization explicitly in JSON where required. For invitation acceptance,
use a personal login and pass the JSON body containing the token through stdin.

For GitHub repair, run `armada api github/refresh '{"id":"<sandbox>"}'`. Read broker status via
`POST /api/v1/github/runtime-status`.

For MCP coordinator launches, call `launch` with optional `size`, a stable
`idempotencyKey` and an `externalRef`. After an uncertain response, repeat the
same call with the same key, then use `list` with the reference to find any
registered sandbox. Escalate unresolved allocations with the original key and
any receipt UUID returned. On success, pass `sandbox.id` to subsequent tools.

## 2. Choose before launching

- Inspect `armada snapshot ls --json` and `armada template list --json`.
  To refresh a shared snapshot, update its build configuration with the owner authorization.
  A golden is a provider-specific saved environment; a template is an immutable
  revision specifying a golden, harness and configuration. Use IDs if names clash.
  Use `armada api golden/capabilities` for provider capacity and the
  authenticated REST adoption endpoint for canonical Boat golden adoption.
- Call MCP `launch_options` with `{}` for the server’s harnesses, models, sizes and TTL limits.
- Call MCP `outputs_list` with `id` to list the stored output snapshot. Call `output_read` with `id` and `name` for base64 contents up to 32 KiB. Use the REST output download for larger files.
  MCP `launch` takes a Boat or Modal golden. Choose `provider: "boat"` or `provider: "modal"`,
  specify `harness`, and use `ttlSeconds` and `reasoningEffort` for launch overrides.
  For scoped tokens, omit `org` or use the scoped org UUID.
- Choose the provider that owns the golden. A golden built on one provider
  is not automatically available on the other. Check
  `armada api golden/capabilities '{"provider":"boat"}'` (or substitute modal).
- All launches through `POST /api/v1/sandbox/launch` require an explicit provider
  and harness. The server resolves model credentials during launch. Personal sessions can select the organization by slug or UUID. For a scoped token, omit `org` or send its org UUID.
  A malformed request returns HTTP 400 with error code `invalid`.
  For REST golden and Docker launches, read the Armada ID from `sandbox.id`.
  A fresh ordinary Boat REST launch returns HTTP 202. A keyed replay returns HTTP 200 with the same sandbox ID and its current status.
  The TypeScript SDK infers its request, response and error types from the API contract. Use `outputs.list` and `outputs.get` to read stored sandbox outputs.
  Modal REST and MCP launches and ordinary Docker REST launches return a sandbox ID and `starting` before allocation.
  Follow that ID with status or logs to find the first prompt after enrolment. Use status to check queued prompt admission.
  Docker snapshot launches report their source `snapshotId`, `hostId` and `image` in `sandbox/status`.
  For template launches, check `"requestId" in result`
  before reading the receipt. Boat, Modal, and Docker templates return `starting` before allocation.
  Use its sandbox ID with status or logs to follow startup. Use the shared `SendInput` for follow-up prompts.
  Ordinary Docker REST launches require `idempotencyKey`.
  Save the key and replay the identical request after an uncertain launch.
  With `armada new --provider docker`, pass the saved key as `--idempotency-key`.
  For a pinned Modal template on `sandbox/launch`, supply `idempotencyKey` and
  read `sandbox.id`. With `templates/launch` or `armada template launch`, use
  `requestKey` or `--request-key` and read the template receipt.
- Ordinary Boat and Modal launches return `sandbox.id` and `starting`. Use that ID to read status while the runtime enrols. Check provider availability in
  the authenticated response to `POST /api/v1/launch/options`.
- Choose the harness and a model/effort it supports. Launch selections persist
  for later turns. Do not assume provider sizes have equal price or performance.
- If a runtime launch returns `credential_binding_required`, add the model account
  in Models → Add account or run `armada account add KIND --name NAME --file PATH`.
  Use `armada account ls` to find the account ID, then retry the launch with
  `--credential-id ACCOUNT`.
- Bound TTL, size and concurrency to the task. Start small unless evidence calls
  for more. `armada api sandbox/advice '{"id":"SANDBOX"}'` provides bounded historical resource
  evidence; unknown evidence is not a recommendation to upscale.

Example (replace the skill pin with an accessible, exact version):

```sh
armada new GOLDEN --agent codex "Implement the agreed change; push the branch and report tests" --provider boat --ttl 30m --skill review-helper@1.2.3 --json
```

Launch without a prompt creates an idle sandbox. Capture its returned sandbox
ID from `sandbox.id` in `armada new --json` output immediately. If the
terminal disconnects before you capture the ID, inspect `armada ls --owner me --json` and `armada info SANDBOX --json` to avoid paid
duplicates. Skill pins are repeatable, exact launch-time references, not floating
latest versions. Private pins use bare slug@exact-version in the credential’s workspace; qualified
org/slug@exact-version pins always use the anonymous public catalog, even when
a key exists. Private pins require a configured Skillpack credential and
access to the package; do not put that credential in a golden or prompt. Check
`armada info SANDBOX --json` for recorded skill references/checksums. Do not
claim a skill is active merely because its package exists locally.

Use `armada ls --status running` to filter by state, or `armada ls --ref REF`
to match an external reference supplied at launch.

For a template, inspect `armada template get TEMPLATE --json`, then use:

```sh
armada template launch TEMPLATE --request-key UNIQUE_KEY --revision 1 --prompt "Implement the agreed change" --ttl 30m --json
```

Persist the resolved template ID, request key and exact request. If the outcome
is unknown, retry that SAME ID, key and body; never generate another key just
because the terminal timed out. Only prompt, TTL, size and repository override
launch defaults; configuration changes require a new published revision.

## Scheduled routines

Manage schedules in Dashboard **Routines**. A routine pins a template version
and runs as its original owner. Creation starts paused. Use five-field cron and
an IANA time zone, with runs at least one hour apart.

For automation, use `armada api routines/list '{"org":"ORG_UUID"}'` to find IDs
and `armada api routines/get '{"org":"ORG_UUID","id":"ROUTINE_UUID"}'` to read the
current configuration and version. Send complete JSON bodies for
`routines/create` and `routines/update` via `armada api ROUTE -` with redirected
stdin. Update, enable, pause and delete require `id`, `org` and the current
`expectedVersion`. Enable schedules the next matching occurrence. Pause and
delete stop new admissions. Check `routines/history` with the routine ID and
organization UUID for admission and original prompt outcomes, including skips
and uncertainty.

## 3. Drive a turn without busy polling

```sh
armada prompt SANDBOX "Continue with the next agreed task"
armada info --wait SANDBOX --timeout 120 --json
armada events SANDBOX --tail 50 --json
armada info SANDBOX --json
```

Send starts a new turn in the sandbox's conversation. Launch another sandbox
for a separate conversation. The dashboard transcript shows sandbox history
and its composer targets the sandbox automatically. Steer redirects an active turn:
`armada prompt --steer SANDBOX "Keep the public API unchanged"`. Use
`armada stop SANDBOX --turn` to request interruption, then run `armada info SANDBOX` before
sending replacement work. Do not treat steer as a guaranteed new turn or send
as a safe interruption mechanism. Capture returned prompt/turn identifiers.

On MCP, use `send` with `steer: true` and the instruction in `prompt`,
`status` with `wait: true` and optional `timeout_seconds`, or `stop` with
`turn: true` to interrupt while keeping compute up. Steer and interrupt
target the sandbox by ID. To wait for settlement and stop only if still idle,
use `stop` with `after: true` and optional `timeout_seconds`. A receipt with
`timedOut: true` means this call did not request a stop.

Steer receipts report `in-place` when the active turn accepts the message, or
`restart` when delivery continues the conversation in a replacement turn.

Use blocking wait instead of tight status loops. --timeout is in seconds,
accepts 0–600 and defaults to 60; the example waits at most 120 seconds. A
still-running result can be waited on again, not relaunched. A wait response is
an observation, not proof tests passed or work was pushed; inspect outcome and
logs. If a send times out ambiguously, use `armada info SANDBOX --live` and
`armada events SANDBOX --tail 50` before considering another send; do not replay a possibly accepted instruction. Use
`armada events SANDBOX -f` to follow until settled, or `armada events SANDBOX --tail N`
for bounded diagnostics. Piped output is JSON
Lines, with one event per line. Use `armada exec SANDBOX -- "git status --short"`
to run a shell command inside the sandbox. For an interactive PTY shell over the relay,
run `armada shell SANDBOX --cwd /home/user` (or omit `SANDBOX` to use `ARMADA_SANDBOX` / `.armada/sandbox`).
To tunnel a sandbox TCP port to loopback `127.0.0.1`, run `armada port-forward SANDBOX 3000 8080`
(local port defaults to remote port). Use `armada outputs --id SANDBOX` to
list stored outputs and `armada outputs NAME --id SANDBOX -o DIR` to download one.

For a viewer grant, subscribe to `GET /api/v1/events?sandbox=<UUID>` with
the viewer bearer. Resume with the last processed SSE ID in `Last-Event-ID`.
Fetch message content with `POST /api/v1/viewer/logs` and its separate log cursor.

## 4. Preserve work and manage lifetime

Use `armada api sandbox/extend '{"id":"SANDBOX","ttlSeconds":3600}'` before
expiry if more time is justified. Include `org` in the body when targeting an
organization. Confirm the returned expiry. New Boat launches use the Armada
runtime by default. Boat logs and token usage require runtime enrollment. For
enrolled Boat, choose the needed lifetime at launch
because extension returns `extension_state`. Use `armada stop SANDBOX --after`
to wait for the turn to settle before requesting an idle-only stop.
Ask the agent to commit and push, and verify branch/PR/head SHA independently
before `armada stop SANDBOX`. Stop is not delete, but provider retention is not
a substitute for a pushed branch. Modal retains disk only after a successful
checkpoint; checkpoint_failed_disk_not_retained means it cannot resume. `armada rm SANDBOX --yes` permanently deletes
a stopped sandbox and recovery archives: require explicit user authorization
and confirmed recovery first. For direct API callers, use
`DELETE /api/v1/sandboxes/{id}`. Reuse the optional `requestId` query parameter
after an uncertain Docker deletion. The dashboard
uses the REST operations for extension and stopped Docker sandbox deletion.

For resource advice and preserved archives, use `armada api sandbox/advice '{"id":"SANDBOX"}'`
and `armada api sandbox/recovery '{"id":"SANDBOX"}'`. If a route needs organization scope, include
`"org":"ORG_UUID"` in the JSON body. Explicit runtime checkpoint and resume use the
owner REST routes `sandbox/checkpoint-runtime-v1` and `sandbox/resume-runtime-v1`.
Send and runtime resume select the conversation from the sandbox ID. Launch another
sandbox for a separate conversation.

Read [failure and recovery](references/recovery.md) before recovering stopped
machines or unpushed work. One authorized armada prompt to a retained stopped
sandbox resumes it and continues its conversation, subject to current credential
and access gates. This starts a new agent turn. For a standalone Docker restart,
use the owner REST route `POST /api/v1/sandbox/resume` with `id` and a
`request_id` UUID. Reuse that UUID after an uncertain outcome.

A `docker_host_upgrade_required` refusal means the daemon must be upgraded.
After the protocol-aware release ships, use `armada host add` and run its
generated installer on the existing Docker host. Check `armada host ls --json`
for the reported protocol and `upgradeRequired: false`. Use `armada host ls HOST`
for a particular machine, `armada host limits HOST` for resource settings, and
`armada host rm UUID` for authorized registration revocation. The local Docker
daemon binary handles status and uninstall on the Docker machine.

## 5. Several sandboxes, including a sandbox as caller
A scoped child launch receipt confirms admission. Read the child to follow its
startup. The provider ID is null until allocation binds a machine.

The same API-only CLI can drive other sandboxes wherever it is installed with
an explicitly authorized Armada session/token and server access. Do not assume
launch injects Armada credentials, automatically delegates authority, or gives
a parent access to every child. Current launch-time Skillpack support does not
imply automatic Armada authentication. Check identity/scope from inside the
caller before launching anything; never copy provider/database credentials.

Keep a small ledger: task, sandbox ID, provider, prompt ID, branch, request key,
expiry, outcome and pushed SHA. Use separate branches and bounded concurrency;
wait on known IDs rather than launching replacements for slow work. Collect
failures independently so one blocked task does not hide running paid machines.
Do not impose a project orchestration or merge method through this skill.

## Output contract and safety

Report IDs, actions actually completed, turn outcome, evidence (tests and pushed
SHA/PR), remaining paid sandboxes/expiry, blockers and next action. Distinguish
CLI-help validation from live server validation. Never claim a staging run,
credential refresh or successful recovery that you did not observe. Do not
merge, deploy, delete resources or alter org-wide settings without authorization.

### Give an agent API access

From a personal login, open Dashboard **Settings → API keys** or run
`armada api token/create '{"label":"worker","org":"ORG_UUID","expires":"30d"}'`.
Capture the response's `token` once and supply it through the agent's secret store as `ARMADA_TOKEN`
with `ARMADA_URL` set to the API origin. Verify with `armada whoami --json`. From a personal login,
use `armada api token/list` to find the key ID, then
`armada api token/revoke '{"id":"TOKEN_UUID"}'`.

### Administrative operations

For MCP registry changes, model-account presets, and other administrative work,
use the dashboard or the [CLI administration routes](https://github.com/The-Vibe-Company/armada/blob/main/docs/cli-admin.md).
For example, list connections with `armada api mcp/list '{"org":"ORG_UUID"}'`.
Use `armada api ROUTE -` with JSON on stdin for bodies that contain credentials.
