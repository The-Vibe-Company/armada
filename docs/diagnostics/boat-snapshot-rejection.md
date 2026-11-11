# Boat saved-snapshot rejection (#931)

Investigation (2026-11-11): the secure golden builder sent
`POST /saved-snapshots` with `{sandboxId, name: "golden-" + builder.id}`.
Boat IDs contain an underscore (`bx_…`), which is illegal in saved names.
The separate `boatSnapshotName` hash helper is not used by this path.
Initial names now replace underscores with hyphens; rebuild revision UUID
names were already legal. Neither request sends `noEnv`: that is a sandbox
creation option, explicitly true on the blank golden builder, not a snapshot option.

Primary references:
- [Save API](https://docs.boat.dev/api/reference/snapshots/save-saved-snapshot): names match `^[a-z0-9][a-z0-9-]{0,62}$`; reserved words are forbidden.
- [Saved snapshots](https://docs.boat.dev/snapshots/templates): trial accounts cannot save snapshots; paid plans include an allowance and extras require wallet credit.
- The save API documents exhausted extra-snapshot credit as HTTP 402 and an in-flight save as 409. A 400 alone does not establish an account/plan problem.

The invalid name is a proven request defect, not proof of the exact staging
rejection cause. No live account was accessed. A staging rerun must confirm
success. For a rejection, collect only `golden_build_failed`'s buildId, phase,
code, provider, HTTP status and closed detail class. Never copy upstream message,
providerCode or details: those can carry secrets. Detail classes are diagnostic
hints, not authoritative billing diagnoses.

Explicit non-mutating refusals now stop the builder and release the reservation.
Ambiguous outcomes or retained-resource evidence still require reconciliation;
do not clear capacity just because a save returned an error. Existing recovery
rows are not changed by this PR. An operator must inspect the original staging
job's state, builder receipt and backend slot before reconciling it; this change
cannot attest that historical resources were stopped.

Apply the new failure-reason constraint migration before running this server.
Owner status exposes only `provider_snapshot_rejected`, with closed retry guidance.
