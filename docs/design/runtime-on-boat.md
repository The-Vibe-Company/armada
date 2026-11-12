# One Armada runtime on Boat (#1161)

Design-only first PR for #1161 / #1160; no runtime selection changes here.
The proposals below are gated by a disposable staging spike, not vendor promises.

## Current state

- `packages/provider-boat/src/provider.ts` sends prompts to `api.prompt`, resumes
  Boat compute and installs native harness configuration; `src/events.ts` maps
  Boat events. `src/native-usage.ts` (see `docs/design/boat-native-usage.md`)
  already extracts native usage: the ticket's “no usage” observation predates it.
- Modal runs `packages/agent-runtime/src/main.ts`: stdin bootstrap, Bun HTTP
  server, `Journal` SQLite state, Claude SDK and Codex app-server drivers.
  `packages/provider-modal/src/distribution.ts` supplies an immutable image,
  stdin credentials and a single-process lock. `src/transport.ts` sends protocol
  v1 requests over HTTP with a connection token and generation-bound grant.
- Boat already offers exec and pinned SSH (`Provider.sshKey`,
  `packages/core/src/ssh-executor.ts`). Neither proves that a detached runtime,
  private HTTP transport or its files survive a Boat machine replacement.
- `docs/design/sandbox-helper.md` and `sandbox-reporter.md` are earlier sketches,
  not evidence of a deployed shared runtime on Boat.

## Target and proposed delivery

One runtime owns harness spawning, turn identity, events, usage and control on
Boat and Modal. Keep the public Provider/API contract; do not introduce a new
orchestrator, proxy, usage ledger or general transport framework.

Extend the target-Linux artifact from `packages/agent-runtime/build.ts`
(bundle, native harness executables and manifest) to include a checksum-verified
pinned Bun binary; today Modal installs Bun separately. Prefer a
content-addressed, verified install under the persisted home directory on launch;
reuse a matching digest on subsequent launches/resume. Old goldens must work
without rebuilding. An optional credential-free golden cache can follow only if
measurements justify it; never snapshot a live runtime or its credentials.
Atomic unpack/install must reject architecture, digest and protocol mismatches.
Size and start cost are **not measured yet**; do not assume the JS bundle is the
whole distribution (native executables and Bun dominate the transfer budget).

Proposed control transport: pinned SSH from the server to Boat, forwarding to a
loopback-only runtime HTTP listener, carrying the existing protocol v1 envelopes.
Use SSH stdin for private bootstrap and request bodies, not command arguments or
Boat command output. Modal's authenticated tunnel is not a Boat capability.
Change `main.ts`'s current `0.0.0.0` binding via an explicit bind option before
using this scheme. No public runtime port. Validate reconnect, bounded requests,
response identity, cursor pagination and lock ownership in the spike. If SSH
forwarding is unavailable, record that blocker before choosing an alternative;
do not silently substitute Boat's native prompt API. Outbound HTTP already used
by runtime callbacks is not itself a server-to-runtime control channel.

Persist journal, driver conversation state and non-secret artifact identity in
home, not `/run`. Stop must quiesce the runtime, flush events/checkpoint auth via
existing runtime mechanisms, then stop Boat compute. Resume must obtain fresh
SSH access, restore the same journal, rotate the grant/generation, redeliver
credentials and start one detached, locked runtime before accepting a turn.
A lost response is not permission to replay a prompt: reconcile its persisted
identity/status first. Retained events remain readable without starting a model;
crashed turns must be reported honestly rather than fabricated as completed.

Bootstrap model/MCP/GitHub credentials privately after launch authorization;
never bake them into goldens or place them in argv, logs, API responses or the
repository. Reuse sealed server storage and existing runtime auth checkpoint
rules. Template readable variables and secrets go to the selected harness via
the shared runtime configuration, not Boat's world-readable native wrapper.
Credentials must be refreshed on resume, not recovered from a golden.

## Small, independently mergeable slices

Each later branch starts at fresh `origin/main`, uses `codex/1161-<slug>` and a
PR with `Refs #1161`. This design does not claim the ticket's final acceptance.

1. **Spike + Codex opt-in:** disposable staging Boat; install verified artifact,
   bootstrap, health, one Codex prompt and cursor events. Server-side per-sandbox
   selection defaults off and is persisted; no silent mid-session fallback.
   Report measured blockers and timing before expanding rollout.
2. **Lifecycle/parity:** steer, interrupt, stop/resume, Claude, usage, MCP/GitHub,
   readable variables and template secrets. Reuse runtime journal/protocol and
   launch admission; preserve visibility and credential-resolution rules.
3. **Default on:** new Boat sessions use the runtime after parity smoke passes;
   name a drain/retirement plan for existing native conversations, which cannot
   be presumed importable. Owner decides timing regressions before rollout.
4. **Delete native:** after native sessions are retired, remove Boat prompt,
   steer/interrupt runner calls, event mapping, native usage extraction and
   native harness configuration/wrappers made dead. Keep Boat compute, exec,
   SSH and golden operations. No permanent two-runner mode.

## Staging verification and measurement (coordinator-owned)

This PR: no deployment needed; inspect referenced files and verify doc scope.
Workers hold no staging/production credentials and perform no deployment.

For slice 1, on disposable staging compute record artifact compressed/unpacked
bytes, install time, runtime readiness, launch-to-ready and launch-to-first-event.
Run at least five matched baseline/native and opt-in launches (same golden,
region, harness/model and prompt); separate cold install, digest-cache hit and
resume. Report raw timings, median and range in the implementation PR; call out
any >20% regression against the corresponding baseline for an owner decision.
Also kill/restart the process, stop/resume compute and drop an SSH response;
verify journal/cursor continuity, single runtime and no duplicate turn. These
are pending experiments, **not observed blockers or survival guarantees**.

For slices 2–4, coordinator supplies staging `ARMADA_URL`, `ARMADA_TOKEN` and
`ARMADA_SMOKE_CASES` with Boat Codex and Claude cases as documented at the top of
`scripts/post-deploy-smoke.ts`, then runs:

```sh
ARMADA_SMOKE=create_real_compute bun scripts/post-deploy-smoke.ts --lifecycle
```

Expected: existing launch/send/stop/resume/stop and idle-steer-refusal checks pass for
both harnesses, unchanged access rules, runtime-origin events and per-turn
harness token counters (unknown stays unknown, never invented zero). Extend the
smoke in the parity slice to assert runtime identity, cursor replay without
double counting, active steer, interrupt, MCP/GitHub, readable-variable delivery and secret
non-disclosure; the command alone today does not establish these new checks.
Deletion also requires a source audit proving no Boat native prompt call remains.

## Boundaries and Later

Model connections/endpoints belong to #1162, cost/pricing to #1163, OpenCode to
#1164 and Docker hosts to #1165; consume their contracts, do not build them here.
Later: multi-tenant process isolation beyond the owner-team requirement, golden
prewarming if justified, broader transport abstractions only for a proven need.
