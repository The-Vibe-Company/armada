# Interrupted Modal golden builders

A build may enter `recovery_required` during SDK creation before the job can save
its builder ID. Modal already has a durable logical reservation keyed by the
build job UUID. Losing the SDK response is not permission to issue another create.

The server resolves the job's sealed immutable provider target and current,
authorized management connection. Core uses the optional explicit provider
capabilities `findGoldenBuilder` and `disposeGoldenBuilder`; it never scans Modal
records or selects a local profile. Discovery is read-only and returns only a
logical ID and a disposable/retained disposition. Modal requires the exact request
key, tenant, original owner, visibility, App/environment/workspace binding and
explicit recorded management provenance. Missing provenance is not adopted by
legacy fallback.

Recovery attempts rotate only their bookkeeping timestamp under the unchanged job
fence, so an older retained or unavailable queue head cannot starve later jobs.
Source, proof, state and capacity are not changed by that rotation.

Core commits that logical ID only while the same job state, fence, phase and
execution context remain current, rechecking live authorization. That commit must
complete before any recovery disposal. Every later tick repeats discovery and
requires the discovered ID to match the persisted binding. A stored ID records
provenance progress, not safe-disposal proof.

Recovery disposal rechecks authority and snapshot/recovery retention under the
existing Modal lifecycle lease, including after remote observation. It uses the
existing exact App/environment/name lookup with all three ownership tags and
`includeTerminated: true`, even when a physical ID was previously persisted. A
named ID differing from that recorded physical ID is never adopted. NotFound, timeout, missing reservation, mismatched tags
or uncertain termination leave recovery pending; they never cause a replacement
create, build-command replay, reservation deletion or capacity release. Repeated
and concurrent ticks remain fail-closed. Recovery disposal does not collect or
delete images. Snapshot/publication-dependent jobs and retained private artifacts
must be reconciled by their retention owner before source disposal can proceed.

Only confirmed disposal permits the job to become failed and release its owned
capacity slot. The logical Modal reservation remains durable. Boat's stop-based
recovery and admission/publication protocol are unchanged. No public recovery
endpoint, schema migration or automatic operator action is added.

Tests use actual migrations/PGlite and a synthetic SDK. Production diagnostics,
resource decisions, credentials and job operations belong to the integration
owner; do not copy payloads, machine records or upstream SDK errors into logs.
