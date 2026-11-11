# Provider/harness launch phase breakdown (#978)

Coordinator night baseline: launch-to-ready8–12s (one after-run12.4s), prompt
admission3.45s and first text7–9s. There is not yet phase evidence attributing
the launch wait to cloud allocation, boot, Git, skills or MCP. This diagnostic
patch does not claim a launch speedup or change launch behavior.

## Closed server timing phases

Successful authenticated API launch responses now include fixed-name
Server-Timing durations, recorded by the same staging probe's serverMs map:

- launch_authorize / launch_provider: API target authorization and provider setup.
- launch_lookup: golden lookup(s), aggregated across API routing and core lookup.
- launch_defaults / launch_connections / launch_credentials: current defaults,
  connection authorization and model/GitHub credential resolution.
- launch_claim / launch_admission: golden-operation claim and native/before-fork admission.
- launch_fork: the complete provider fork call, **including any provider-owned boot
  or runtime installation**. It is not a pure cloud allocation duration.
- launch_register / launch_bind: durable sandbox registration and connection binding.
- launch_ready: core readiness polling after provider fork returns (may be tiny
  when that provider already waits for readiness internally).
- launch_hydrate / launch_github: native model and GitHub setup.
- launch_pull / launch_init: sequential repository pulls and init commands,
  aggregated across each repository/command, with existing order and timeouts.
- launch_cwd / launch_skills: selected native cwd and verified skill installation.
- launch_mcp / launch_before_start: MCP preparation and final-start admission.
- launch_probe: Boat's installed native-wrapper health probe.
- launch_prompt: initial prompt admission only when launch includes a prompt.
  The standard probe launches idle, then measures send separately as before.

Phases are nested in dispatch; do not sum overlapping phases or aggregate
percentiles. Missing phases are absent, not zero. Names never contain repository
names, commands, skills, account IDs, credential values or prompt content. No
raw error reporting, new service or database migration. Both providers use the
same core observer; there is no claim of an internal provider subphase trace.

The observer is cloned per authenticated control request, composed with any
existing trusted launch observer, and not accepted from request JSON. Existing
registration/fork/credential/cleanup fences, source authority, signal budgets and
launch failure classification are unchanged. No operations parallelized/cached.

## Same-method coordinator commands

After merge/deploy, on the same host/network/org and provider-specific golden:

```sh
bun install --frozen-lockfile
# Securely export STAGING_URL, STAGING_ORG and ARMADA_TOKEN as before.
python3 scripts/perf/staging.py --samples 20 --provider modal --harness codex --golden smoke-modal > /tmp/launch-modal-codex.json
```

Default remains Modal/Codex, so the previous command is equivalent. To measure
another existing pair, choose --provider boat|modal and --harness claude|codex,
with a snapshotted golden of that provider and a working model account/default.
**Each invocation allocates one billable disposable sandbox**, not all four.
Confirm cleanup.deleted=true and post full JSON/deployed SHA on #978. The selected
pair is recorded in report metadata; client wall timing and payload method stay
the same, and SQL trip counts remain unmeasured. No staging allocations or deploys
were performed in this coding session.

## Local evidence

Existing success, idle (now Boat/Modal) and failed-init tests exercise observer
coverage/order, two sequential pulls aggregated, absence of an idle launch prompt,
unchanged failed-state/stop/redaction behavior and single allocation/submission.
The timing assertions fail on baseline code and pass with instrumentation. A real
HTTP launch boundary checks phase headers and that a configured observer survives
request-local composition. Offline probe exercises4pairs × success/failure, each
with exactly one launch, phase statistics, cleanup and token/body suppression.
No orchestrator-specific code/tests, new launch capability or migration.
