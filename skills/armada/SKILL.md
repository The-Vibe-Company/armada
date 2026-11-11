---
name: armada
description: Use the Armada CLI to launch and drive coding agents in remote sandboxes, inspect turns and failures, and preserve work. Use for terminal-based Armada operations, not a project-management or merge method.
---

# Armada from a terminal

Armada launches agents; you decide the work, review and merge policy. A sandbox
can drive other sandboxes with its own authorized Armada session. No persistent
coordinator resource is needed. Do not assume a child inherits your login,
organization, credentials or permissions.

This skill ships in the CLI repository. Check the installed version and help
before using it with a different release:

```sh
armada --version
armada --help
```

Examples use GOLDEN, TEMPLATE, ORG and SANDBOX as placeholders; replace SANDBOX
with an Armada UUID, not a provider ID. Prompts are examples, not permission to
launch or spend money. Run only operations the user authorized.

## Sign in and select resources

```sh
armada login --provider github
armada account status
armada org list
armada org use ORG
armada org current
armada org setup
armada golden list --provider boat --json
armada template list --json
armada template get TEMPLATE --json
armada creds list
```

Login is interactive; agents should use an existing session or an authorized
ARMADA_TOKEN from secure environment configuration, never ask for a token in
chat. ARMADA_URL selects the server; confirm the intended environment before
mutating it. Organization selection is persisted per server. Use explicit
organization selection when driving several organizations.

Choose a golden already built for the desired provider: Boat and Modal goldens
are separate. A template is an immutable preset, not another machine. Inspect
its revision and resource choices before launching. Use a model/effort supported
by the installed CLI and the selected model account; consult launch help rather
than guessing model IDs. Personal model credentials take precedence over org
defaults. Never copy tokens into prompts, git, goldens or command arguments.

## Launch and keep the identity

```sh
armada launch GOLDEN --agent codex --provider boat --ttl 30m --json
armada template launch TEMPLATE --request-key REQUEST_KEY --prompt "Inspect the assigned issue; report a plan." --ttl 30m --json
```

An idle launch starts no turn; send the first prompt separately. Capture the
returned sandbox ID and prompt/conversation IDs. A template request key identifies
one launch intent: save its resolved template ID, key and exact request body.
After an ambiguous response retry the same ID/key/body, not a new key. Ordinary
launch is not a safe blind retry: inspect the sandbox list after transport failure.

The model and reasoning effort chosen at launch persist for later turns.
Repository/size choices affect cwd/resources, not security confinement.
Prefer a small adequate model, bounded task and short TTL; several sandboxes
multiply provider and model costs. Size labels are not equivalent billing units
across providers. Extend intentionally before expiry, not on every status check.

## Drive a turn, not a polling loop

```sh
armada send SANDBOX "Inspect the assigned issue; report a plan." --json
armada wait SANDBOX --timeout 60 --json
armada status SANDBOX --json
armada logs SANDBOX --all --json
armada logs SANDBOX --since CURSOR --json
armada steer SANDBOX "Keep the change inside the assigned issue." --json
armada interrupt SANDBOX --json
armada extend SANDBOX --ttl 1h --json
```

Send starts a new prompt; steer redirects an active turn. Interrupt stops a turn,
not the machine. Do not send duplicates to wake a busy agent. Wait blocks for a
bounded interval (timeout is integer seconds, not a duration such as 1m).
A wait timeout is not task failure: wait again if the task remains active.
Use status to diagnose a transition, not a tight repeated loop. Inspect the
returned final outcome and failure reason, not just the command's exit code.

Logs drains available event pages with --all; it does not wait indefinitely.
For incremental reads, save the returned cursor and pass it as --since on the
next logs call. Avoid reprinting whole transcripts; events can contain private
source or command output. A completed turn does not prove tests or a PR are ready.

## Preserve work and handle failures

```sh
armada exec SANDBOX "git status --short" --json
armada github status
armada github refresh SANDBOX
armada stop SANDBOX --json
umask 077
armada recovery SANDBOX --json > RECOVERY_FILE
```

Before stopping, have the agent commit and push authorized work, then verify the
remote SHA/PR. Stop and interrupt are different. Stop may preserve provider state
but is not a backup guarantee. Do not permanently delete a sandbox with work
remaining. Recovery output can contain a sensitive base64 archive: redirect it
to an access-restricted local file, never chat or shared logs; inspect/extract in
an isolated directory, not over a checkout. Recovery availability is provider
and lifecycle dependent; a null archive does not mean there was no work.

There is currently no top-level CLI resume command. Check current help and use
the supported provider/dashboard lifecycle rather than inventing a resume flag
or replacing a stopped sandbox with a fresh golden (which loses local changes).
Application-secret-exposed disks may be deliberately non-resumable. Stop on a
policy refusal; do not bypass it through direct provider operations.

For GitHub authorization failures, inspect connection status, reconnect through
the supported browser flow if needed, then refresh the existing sandbox. Refresh
does not authorize a repository the caller cannot access. A refreshed GitHub
credential does not fix model authentication or a disconnected provider.

For an unknown write outcome, inspect state before retrying. Separate auth and
membership failures from capacity, expired lifetime, unsupported capability and
agent/task errors. Preserve sandbox/prompt IDs and redacted error codes when
reporting a blocker; never dump credentials or recovery archives for diagnosis.

## Credentials and readable configuration

```sh
armada creds set openai --file CREDENTIAL_FILE
armada vars --help
armada secrets --help
armada template --help
```

Credential values come from stdin or protected files, never argv. Check account
scope/defaults before changing them. Readable variables are non-secret
configuration: template revisions reference them, and a launch freezes resolved
values. Do not put passwords in readable variables. Application secrets are a
separate write-only vault; storing one is not a promise that this CLI launch
delivers it to a sandbox. Consult current help and refusal reasons rather than
inventing environment-injection flags.

## Several sandboxes

Maintain a small ledger: task, sandbox UUID, provider, branch, latest prompt,
cursor, expiry, pushed SHA and next action. Give each worker a disjoint scope and
branch. Launch only the authorized concurrency; wait on active turns in bounded
calls instead of repeatedly listing everything. A worker may drive another
sandbox, but that does not grant it permission to merge, deploy or provision
unbounded descendants. Collect pushed deliverables and failure reasons, review
them, then stop idle machines. The skill supplies tool knowledge, not a mandatory
orchestration method.
