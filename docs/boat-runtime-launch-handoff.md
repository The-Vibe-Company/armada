# Core Boat runtime launch handoff (#1161)

The shared launcher now has a **trusted per-launch** `LaunchOptions.boatRuntime`
start policy. `packages/mcp-server/src/boat-runtime-launch.ts` assembles its real
implementation from the existing configuration projector, private SSH bootstrap,
enrolment/readiness service and durable agent bridge. No public API/CLI flag or
default changes are enabled by this slice. Modal/native launches are unchanged.

## Model-only experimental contract

Selected launches are ordinary Boat/Codex workers only. The immutable
`boat_runtime` choice is recorded at insert and checked before initialization;
a store that loses that choice fails closed, never starting a native agent.
Fork uses `noEnv:true` and **empty environment**, not model/GitHub credentials.
Those model credentials go only to the trusted start policy/encrypted enrolment.

This first path uses the golden's checked-out workspace **as-is**: no native
GitHub setup, repository pull, init replay, cwd-wrapper or native CLI health
probe. The result explicitly reports GitHub setup skipped. MCP connections,
merged skills/helpers and managed-parent/access narrowing are refused before
allocation, not silently ignored. Set connections empty and skip skill defaults
when a future explicit API opts in. Parity/in-runtime setup is later work.

The existing beforeStart admission hook and launch lifecycle ownership/cleanup
remain authoritative. Runtime start is memoized per owned launch so re-entry
cannot blindly issue another ticket. Its health must acknowledge a valid epoch;
then only its prompt port can accept the initial prompt. Failure is recorded and
the allocation stopped through existing cleanup; native prompt is never a
fallback. The caller must provide a compute-only host adapter, not native
model-auth lifecycle hooks. Public stop/resume/read routing is not wired here.

Server assembly uses an immutable manifest copy, explicit host architecture,
current persisted model/cwd/binding and the actor's authorized credentials.
Only ticket/public install metadata reach SSH. Initial prompt identity is stable
(`launch_<logical sandbox ID>`), retaining durable uncertain-outcome semantics.
No account/default re-resolution or model credentials in host argv/bootstrap
files/logs. Existing runtime-owned private auth-file handling is unchanged.

`LaunchResult.runtime={kind:"armada",epoch}` is an internal acknowledgement:
with a prompt it follows a validated runtime prompt receipt; idle success means
only initialization. It is not yet exposed by the public control serializer.
Do not mistake stored selection alone for runtime execution proof.

## Coordinator check

No deployment, migration, model/provider call or Boat start needed:

```sh
bun test packages/core/test/launch.test.ts packages/core/test/launch-workdir.test.ts
```

Expected: key/custom endpoint and auth-file contexts reach only the runtime
policy, fork environment is empty, native setup/probe/prompt counts stay zero,
runtime receipt/provenance is returned, unsupported extras refuse before fork,
and startup/selection/epoch/prompt errors fail cleanup without native fallback.
Existing native launch tests still pass. Lower-level tests own actual private
bootstrap, SQL fencing and client/Runner wire contracts.

No new migration; relies on the already-merged runtime-selection schema.
Before future opt-in, publish the matching compiled runtime/harness manifest.
Next: explicit versioned API/CLI selection, persisted-mode read/cleanup routing
and the exact ONE-launch coordinator check on #1161. No real Boat inference or
launch-time comparison was performed here.
