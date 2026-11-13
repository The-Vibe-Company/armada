# Implemented lifecycle state model

Audit baseline: 2026-11-10, issue #829. This describes the implementation, not
a promise that a configured provider passes deployed conformance. See
[smoke boundaries](consolidation-audit.md) and [error codes](api-error-codes.md).

## Ordinary sandbox

The persisted enum is `starting | ready | running | stopping | stopped | failed |
deleted` (`packages/core/src/database.types.ts`). Provider state is a separate
observation, never interchangeable with this enum.

| Operation / writer | Transition and evidence |
| --- | --- |
| Launch (`core/src/launch.ts`) | Insert starting; initialization publishes ready, or failure records failed. A prompt can begin running. |
| Send / turn tracking (`mcp-server/src/tools.ts`, `turns.ts`) | Admit activity under a lease; running reflects a turn, not a new machine. Completion can return to ready or record failure. |
| Stop (`tools.ts`, `sandbox-lifecycle.ts`) | Reserve stop, attempt bounded best-effort preservation, request provider stop; stopping is not proof of physical exit. |
| Reconcile (`sandbox-lifecycle.ts`) | Lease and generation-fence observations; stop on explicit request, interrupted starting, or expiry. Confirmed terminal provider state records stopped; failed launches retain failed and their diagnostic. Physical exit without verified recovery records failed. |
| Resume (`tools.ts`) | New activity/generation fences stale observations; restore retained compute and initialization before readiness. Not a fresh golden launch. |
| Delete (`tools.ts`, `data.ts`) | Owner/current org admin, terminal unmanaged row only; provider deletion must be confirmed before metadata/archives are deleted. |

The reconciler retries unavailable observations without inventing deletion.
A failed row with `stopped_at` is already terminal for reconciliation; a failed
row without it can still own compute. `deleted` is terminal. Stop may leave
`stopping` until retry/observation succeeds. Loss of membership or provider
credentials can prevent that retry from resolving; this is not proof of exit.
Ordinary retention is separate from stop. Legacy managed rows remain excluded
until the separately authorized database retirement.
