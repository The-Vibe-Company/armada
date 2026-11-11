---
name: armada
description: Use Armada from a terminal to sign in, select an organization, choose a golden or template, launch Claude Code or Codex in Boat or Modal sandboxes, pin private skills, send or steer work, wait, inspect failures and preserve work. Use whenever someone asks to launch, monitor, troubleshoot or control Armada sandboxes, including several sandboxes from another sandbox. This is tool knowledge, not a project coordination, code review or merge policy.
---

# Armada terminal guide

Armada launches agents; you decide task ownership, acceptance criteria and budget.
Requires the Armada CLI and access to an Armada server. This skill ships with the
CLI source; check `armada --version` and `armada --help` before using a differently
versioned installation. Read the installed command's help rather than inventing
flags. Examples use placeholders such as GOLDEN, SANDBOX and ORG; substitute real
IDs, and quote prompts as single arguments.

## 1. Establish identity and scope

Run `armada account status`, `armada org list` and `armada org current`.
For an interactive human, use `armada login`; for automation, use an authorized
ARMADA_TOKEN through the environment, never pasted into a prompt or command.
ARMADA_URL selects the server; confirm it before any write. Do not inspect or
print token values. `armada org use ORG` persists the selection for that server;
use explicit organization arguments in multi-org automation to avoid ambiguity.
`armada org setup` diagnoses provider setup. Missing membership or provider
access needs an authorized admin, not a retry loop.

Read [setup and configuration](references/setup.md) when connecting GitHub,
selecting model accounts, creating goldens/templates, or configuring variables.

## 2. Choose before launching

- Inspect `armada golden list --json` and `armada template list --json`.
  A golden is a provider-specific saved environment; a template is an immutable
  revision specifying a golden, harness and configuration. Use IDs if names clash.
- Choose Boat or Modal explicitly when ambiguous. A golden built on one provider
  is not automatically available on the other. Check
  `armada golden capabilities --provider boat --json` (or substitute modal).
- Choose the harness and a model/effort it supports. Launch selections persist
  for later turns. Do not assume provider sizes have equal price or performance.
- Bound TTL, size and concurrency to the task. Start small unless evidence calls
  for more. `armada advice SANDBOX --json` provides bounded historical resource
  evidence; unknown evidence is not a recommendation to upscale.

Example (replace the skill pin with an accessible, exact version):

```sh
armada launch GOLDEN --agent codex "Implement the agreed change; push the branch and report tests" --provider boat --ttl 30m --skill review-helper@1.2.3 --json
```

Launch without a prompt creates an idle sandbox. Capture its returned sandbox
ID immediately; a terminal disconnect is not proof that creation failed. Before
launching again, inspect `armada list --owner me --json` and detail to avoid paid
duplicates. Skill pins are repeatable, exact launch-time references, not floating
latest versions. Private pins use bare slug@exact-version in the credential’s workspace; qualified
org/slug@exact-version pins always use the anonymous public catalog, even when
a key exists. Private pins require a configured Skillpack credential and
access to the package; do not put that credential in a golden or prompt. Check
`armada detail SANDBOX --json` for recorded skill references/checksums. Do not
claim a skill is active merely because its package exists locally.

For a template, inspect `armada template get TEMPLATE --json`, then use:

```sh
armada template launch TEMPLATE --request-key UNIQUE_KEY --revision 1 --prompt "Implement the agreed change" --ttl 30m --json
```

Persist the resolved template ID, request key and exact request. If the outcome
is unknown, retry that SAME ID, key and body; never generate another key just
because the terminal timed out. Only prompt, TTL, size and repository override
launch defaults; configuration changes require a new published revision.

## 3. Drive a turn without busy polling

```sh
armada send SANDBOX "Continue with the next agreed task"
armada wait SANDBOX --json
armada logs SANDBOX --tail 50 --json
armada status SANDBOX --json
```

Send starts a new turn; steer redirects an active turn:
`armada steer SANDBOX "Keep the public API unchanged"`. Use
`armada interrupt SANDBOX` to request interruption, then inspect status before
sending replacement work. Do not treat steer as a guaranteed new turn or send
as a safe interruption mechanism. Capture returned prompt/turn identifiers.

Use blocking wait instead of tight status loops. The default wait is bounded
to 60 seconds; a still-running result can be waited on again, not relaunched. A wait response is an
observation, not proof tests passed or work was pushed; inspect outcome and
logs. Do not add an imagined timeout flag. For longer event inspection use
`armada logs SANDBOX --follow --json`; `armada logs SANDBOX --all --json`
drains available pages. Keep output bounded with tail for routine diagnostics.
Preserve returned cursors/identifiers in reports; do not fabricate a cursor flag.

## 4. Preserve work and manage lifetime

Use `armada extend SANDBOX --ttl 1h --json` before expiry if more time is
justified. Confirm the returned expiry; do not assume extension succeeded.
Ask the agent to commit and push, and verify branch/PR/head SHA independently
before `armada stop SANDBOX`. Stop is not delete, but provider retention is not
a substitute for a pushed branch. `armada rm SANDBOX --yes` permanently deletes
a stopped sandbox and recovery archives: require explicit user authorization
and confirmed recovery first.

Read [failure and recovery](references/recovery.md) for stopped machines,
credential failures, or unpushed work. This CLI version has no general sandbox
resume/recover command. Do not substitute undocumented endpoints or promise
that a stopped machine can be restarted through this terminal interface.

## 5. Several sandboxes, including a sandbox as caller

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
