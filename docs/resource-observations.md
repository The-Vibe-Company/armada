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

The collection/persistence/API integration is not yet delivered by the published
DTO and sampler foundation. CLI consumers must wait for the actual implemented
API contract, keep optional telemetry failure separate from launch/status success,
and never portray these partial samples as a completed sizing assessment.
