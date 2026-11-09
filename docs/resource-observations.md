# Sandbox resource observations (contract version 1)

The browser-safe advice result is `ResourceAdvice` in
`packages/core/src/resource-advice.ts`. It imports the actual size producer's
`MachineSize` and `MachineSizeEvidence`; requested capacity is not measured usage.
An advice result never changes defaults or resizes a running sandbox.

## Supported collection paths

- Boat SDK 1.13.0: fixed `readFile` requests for guest `/proc` counters, with a
  five-second total deadline and 64 KiB accepted per file. No commands, model
  prompts, process dumps or account-wide telemetry changes. A provider refusal,
  unsupported virtual file or invalid boot/time boundary makes data unavailable.
  Boat's account-level `setTelemetry` replaces the sole OTLP destination; Armada
  does not invoke it for this feature.
- Modal SDK 0.11.1: newly reserved managed agent launches explicitly request
  `runtime: "vm"`. The request policy is persisted before named create; successful
  create/reconciliation records the physical ID and generation. Golden builders
  and existing reservations do not acquire this policy retroactively. Restored
  generations of an explicitly managed VM retain the policy but must receive new
  incarnation evidence. Unknown runtime, missing evidence and stopped machines
  are unavailable, not inferred VM scope. Collection uses an authenticated runner
  `resourceObservation` operation, not arbitrary exec or model prompts.

The sampler reads only boot ID, uptime, aggregate CPU ticks, memory gauges, CPU
pressure and kernel OOM count. Reads are bracketed by boot ID and uptime; crossing
boots or a capture longer than five seconds is rejected. Guest ticks have no
assumed USER_HZ. Logical guest CPUs are not Modal physical-core requests. Missing
counters remain null. Captures do not enter the event journal or replay cache.

Official contracts: [Modal Sandbox resources](https://modal.com/docs/guide/sandbox-resources),
[Modal runtime isolation](https://modal.com/docs/guide/sandbox-networking),
[Modal filesystem snapshots](https://modal.com/docs/guide/sandbox-snapshots),
[Boat dedicated VMs](https://boat.dev/). Installed SDK types define the supported
`readFile` and `SandboxCreateParams.runtime` request surfaces. Function metrics
and shared-host `/proc` totals are not Sandbox observations.

## Evidence limits and consumer requirements

These guest samples are **not** proof of lifetime peak memory or hypervisor
throttling. Their envelope explicitly reports these limitations. Low average CPU
alone cannot authorize downsizing. Existing/unknown generations must remain
unavailable. No monetary savings are calculated.

Recommendation logic requires comparable, complete, fresh sessions and explicit
current/candidate scheduler-quota evidence in the same unit. It cannot infer
scheduler quota from a size label, vCPU count or physical-core request. Candidate
eligibility must include plan and source-disk constraints. Unsupported evidence
must cause abstention, not fabricated zeroes or a synthetic recommendation.


## Implemented API and storage

`POST /api/v1/sandbox/advice` accepts `ResourceAdviceRequest` (`{id, org?}`)
and returns `ResourceAdviceResponse` (`{advice: ResourceAdvice}`). The MCP
`resource_advice` tool accepts `{id}` and returns the identical envelope. The
selector is an authorized Armada sandbox ID. Requests collect at most one sample,
with a ten-second cooldown; there is no background workload or model invocation.

New launches pin URL, branch and configured directory from the actual launch
config. Existing rows are not reconstructed. History selects at most ten sessions
with the same owner, org, golden, project identity, provider, harness, model,
effort and requested capacity. Observed guest CPU/memory capacity must also match
the selected session before samples aggregate. Missing/invalid latest sessions
are not replaced by older favorable ones. Cross-generation/boot intervals, counter
resets and gaps outside 1–30 seconds are excluded. Fresh observations use a seven-day
window. Storage is capped at 720 points per sandbox and 14 days; the server's
independent maintenance lane deletes expired rows every ten minutes, including
inactive sandboxes. Removed memberships/private visibility are checked on access.

`sampled` explicitly reports all-activity interval CPU and observed memory gauges,
not active-workload utilization or true peaks. `observations` remains null for
unsupported active-workload evidence. Current guest sources cannot establish
workload/CI-wait attribution, lifetime memory peaks, hypervisor throttling or
candidate plan/disk eligibility. Therefore the implemented API **abstains from
downsizing** (`recommendedSize: null`, `sufficient: 0`). No low-CPU example or
synthetic test input is promoted to sufficient provider evidence. The pure
headroom decision contract is covered for future sources that can satisfy those
requirements, but unsupported inputs cannot reach a recommendation.

## Deployment compatibility

Apply additive migration 207 **after 206 and before deploying the server**. It
adds an immutable nullable launch project and service-only bounded observations;
it never backfills usage or changes existing compute. Regenerated database types
come from the migrations. Deploy the server with its matching rebuilt runner
artifact; the new read-only operation is additive to protocol v1. Existing rows
and unknown runtimes stay unavailable. Rolling the server back leaves nullable
columns/table intact and does not resize or stop VM launches already created.
No production migrations or provider resources are modified by development.
