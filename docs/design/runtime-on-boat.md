# One Armada runtime on Boat (#1161)

The owner’s **Binding design decisions** in #1161 govern this design and
supersede earlier proposals. Design-only PR; implementation follows in small PRs.

## Current state

- `packages/provider-boat/src/provider.ts` uses Boat's native prompt/control
  APIs; `src/events.ts` maps their events. `src/native-usage.ts` already extracts
  native usage, so the ticket's historical “no usage” observation is outdated.
- `packages/agent-runtime/src/main.ts` supplies the shared runtime, journal,
  Claude Agent SDK and Codex app-server drivers. Today it accepts stdin bootstrap
  and serves HTTP. `build.ts` produces JS and native harness artifacts.
- Modal's `packages/provider-modal/src/distribution.ts` and `transport.ts`
  install/start the runtime and use its authenticated tunnel. **Leave Modal
  behavior unchanged until programme order step 6.**
- `docs/design/sandbox-helper.md` and `sandbox-reporter.md` are earlier sketches,
  not proof of a deployed shared runtime on Boat.

## Settled architecture

The host supplies compute only: create from image/golden, run one command with
stdin, provide a persistent directory and outbound HTTPS, stop/resume and delete.
Snapshot, fork and human SSH are optional capabilities. Goldens remain recipes
built separately per host. All agent features belong to the Armada runtime;
Boat's agent APIs are temporary compatibility only until this lane removes them.

**Artifact/install.** Build one compiled executable per OS/architecture with
`bun build --compile`, glibc by default. Ship pinned harness CLIs beside it in a
version/sha256 manifest; fetch only the selected harness. A bootstrap checks the
expected digest and downloads from the Armada server only when missing. A
pre-filled image is merely a warm cache. Support binary self-install for images
without a shell. Change versions only at start/resume, never during a lifetime.
No separate Bun installation is needed for the compiled runtime.

**Transport.** The runtime dials out: WebSocket commands, automatically falling
back to HTTPS long-poll, keep-alive under 30 seconds. Upload journal events as
acknowledged batches; reconnect/replay must not duplicate events or turns.
Do not add SSH-forwarded control, public runtime ports or a new hosted proxy.
This is the Boat implementation first, not a rewrite of Modal's current tunnel.

**Enrolment.** The host passes only a single-use enrolment token over stdin,
never argv/logs. The runtime retrieves configuration and model credentials from
the server at launch and every resume. Each enrolment opens a new epoch; reject
all older-epoch commands/events. The server remains owner of refreshed
subscription tokens, which the runtime returns privately. Reuse sealed storage;
never snapshot credentials into goldens or return them in public APIs.

**State/lifecycle.** Keep the journal and conversation state in the host's
persistent directory. Stop quiesces the runtime and flushes/checkpoints before
compute stops. Resume enrols afresh, restores durable state and starts exactly
one runtime. Reconcile uncertain prompt identities instead of blindly replaying
commands after a lost response. Report interrupted/crashed turns honestly.

**Drivers/usage.** Keep native Codex app-server and Claude Agent SDK drivers.
Tokens come from the harness per turn and are priced server-side; missing figures
remain unknown, never estimated. MCP/GitHub setup and template readable variables
and secrets must go through runtime configuration, not Boat native wrappers.
OpenCode's ACP v1 driver belongs to #1164, not this first Boat slice.

## Evidence and remaining verification

Owner-reported local spikes in #1161: current runtime compiles for Linux x64 and
arm64; about 82 MB raw / 30–37 MB compressed and about 90 ms boot in bare Debian.
These are supplied evidence, not Boat launch measurements or independent results
from this PR. Fake-Claude compiled SDK tests do not prove real harness parity.

Before implementation relies on compilation, verify real Codex app-server under
the compiled runtime on native x64: initialize, thread/turn, events and resume.
Fix `packages/agent-runtime/src/github-tools.ts` self re-exec: its current
`process.argv[1]` assumption breaks compiled execution. Include the fix in the
first bounded implementation work; verify real Claude before Boat Claude rollout.
No worker holds staging/production credentials or deploys this design PR.

## Implementation order and staging gates

Every later branch starts at fresh `origin/main`, uses `codex/1161-<slug>` and
`Refs #1161`. Split the following into small independently mergeable PRs; each
states its exact coordinator-owned staging check. Prove each programme step on
staging with the lifecycle smoke before advancing to the next.

1. **Base on Boat, Codex opt-in per launch:** compiled artifact, digest-checked
   server download/bootstrap, dial-out WebSocket plus long-poll fallback,
   single-use enrolment and epoch rejection. Include the self re-exec fix.
   Verify selected-harness-only download, cold/warm installs, Codex prompt and
   usage, cursor continuity, reconnect, fallback and stale/token-replay refusal.
2. **Claude on Boat, then default, then delete native:** prove real Claude,
   steer/interrupt, stop/resume, usage, MCP/GitHub and template configuration.
   Resolve existing native session retirement before removal; do not assume
   transcripts import. Delete Boat native prompt/control calls, event mapping,
   native usage extraction and dead wrappers/configuration. Keep compute, exec,
   SSH and golden operations. No permanent second agent runner.

Coordinator supplies staging `ARMADA_URL`, `ARMADA_TOKEN` and
`ARMADA_SMOKE_CASES` (Boat Codex for step 1; add Claude for step 2), then runs:

```sh
ARMADA_SMOKE=create_real_compute bun scripts/post-deploy-smoke.ts --lifecycle
```

Expected: launch/send/stop/resume/stop succeeds through the selected runtime.
Extend existing smoke coverage to prove runtime identity, active steer (today it
checks idle refusal), interrupt, harness token counters, epoch/fallback behavior,
MCP/GitHub, readable variables and secret non-disclosure. Test process death and
lost acknowledgements without duplicate execution or usage. Audit source after
deletion: no call to Boat native prompt API remains.

Measure at least five matched native/runtime launches: same golden, region,
harness/model and prompt. Report compressed/unpacked bytes, install/readiness,
launch-to-ready and first-event timings, separating cold, cached and resume.
Publish raw timings, median/range; call out any >20% regression for owner decision.
Boat timings and survival are **not measured by this design PR**.

## Boundaries and Later

#1162 model connections and #1163 session cost start on Modal in parallel;
#1164 owns OpenCode/ACP, #1165 Docker hosts. Consume their contracts, do not
implement them here. Programme order step 6 later moves Modal to dial-out and
deletes its tunnel; changing Modal behavior now is explicitly out of scope.
Later: multi-tenant hardening beyond owner-team needs. Revisit ACP for all only
when v2 is stable, steering standardized and an adapter maintained by a vendor.
