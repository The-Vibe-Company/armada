# Orchestrator database retirement — DRAFT, DO NOT APPLY

Refs #984, step 5. Depends on the separate step-4 server/API retirement draft.
The coordinator must relay the owner's explicit go before either draft is
readied, merged, deployed or applied.

## Version reservation

Migration: `20261112040755_remove_orchestrator_owner_feature.sql`.
It is above `20261112000000` and was checked against local main/history and
all 30 open-PR file inventories on 2026-11-11 after GitHub access was restored:
no collision. Recheck immediately before merge/application; a draft reservation
is not a database lock. Never edit or rename an already applied migration.

## Preparation status and blockers

This is an **unexecuted draft SQL proposal**, not a validated migration or rollout.
No database, staging or production operation was performed. Its guards cannot
replace provider evidence. Disposable migration/dependency/RLS/replacement tests
below have NOT run; generated database types have NOT been regenerated. Retained
owner-only code/test deletion in step 4 must finish first; do not enable this
migration in any automatic rollout until all gates are explicitly approved.

## Intended migration behavior

One transaction locks the legacy identity tables, four shared stores, generic
access parents and sandboxes; bounded lock/statement timeouts fail rather than
leave a half-retired schema. Plan a drained application deployment window because
this temporarily blocks normal access-parent/sandbox writes too.

Before erasure it rejects:

1. Missing/mismatched generic versus legacy parent identities.
2. A legacy parent or access-parent state other than `stopped`.
3. A parent/attributed child sandbox without a closed status and `stopped_at`.
4. Any pending/uncertain owner or old-parent child-operation receipt.
5. A live legacy lifecycle worker lease or unexpired unreleased wait lease.
6. An unrevoked, unexpired delegation matching a legacy parent's current epoch.

These are **necessary SQL preconditions, not provider stop/termination proof**.
The cleanup report and independently correlated provider observations must already
show every parent/child stopped or terminated. A NULL-sandbox legacy identity is
allowed only when state/receipts are terminal; absence alone cannot establish no
allocation. The operator must validate original provider reservations too.

It deletes shared rows only for a transaction-local snapshot of
`armada_access_parents.kind='orchestrator'`. Every ordinary `kind='sandbox'`
parent's authority, child relation, receipts and cap rows remain. Compatibility
sync triggers are removed before this deletion so neither direction can resurrect
or delete the wrong generic identity.

It drops these eight **exclusive owner-feature** tables, with no CASCADE:

- `orchestrators`
- `orchestrator_operations`
- `orchestrator_runtime`
- `orchestrator_runtime_create_keys`
- `orchestrator_runtime_events` (its owned sequence is removed with the table)
- `orchestrator_waits`
- `orchestrator_lifecycle_mutations`
- `orchestrator_activity`

This destroys legacy owner identity, configuration, event/checkpoint projection,
operation/recovery/idempotency history, wait/activity history and legacy-parent
rows in the shared stores. Back up the required audit evidence before approval.
There is no lossless rollback: reverting application code does not restore erased
rows. Restoration needs the authorized pre-migration database backup, and must not
re-enable old native grants automatically.

## Shared infrastructure intentionally retained

Do **not** interpret an `orchestrator_*` name as proof that it is owner-feature-only.
#1002 uses these established stores directly:

- `armada_access_parents`
- `orchestrator_delegations`
- `orchestrator_children`
- `orchestrator_child_operations`
- `orchestrator_lifecycle`
- `sandboxes.orchestrator_native_generation`

Keep `guard_armada_access_parent`, `guard_orchestrator_child`,
`guard_orchestrator_child_operation`, `revoke_removed_orchestrator_member`,
`revoke_rebound_orchestrator_native`, `fence_sandbox_armada_access`,
`owns_armada_access_parent`, their triggers/policies and the service-only authority
column grants. The native-generation and membership-revocation functions already
point to generic access parents after #1002's migration.

`guard_orchestrator_sandbox()` is replaced in place: its trigger and execution
restrictions survive, while the parent lookup becomes generic. Child owner/org
immutability stays enforced. The existing generic fence independently protects
parent access and golden binding.

`sandbox_list_metadata()` is replaced in place using the current
`20261110121900_work_preservation.sql` return type/body, dropping only the legacy
identity exclusion. Membership, `can_open_sandbox`, private outcome projection,
readable preservation metadata, provider/Boat alias handling, stable ordering,
security-definer search path and execution grants are preserved. Old stopped
sandbox rows consequently become ordinary listed history under existing
owner/admin interior access rules; no sandbox row, native conversation,
`sandbox_work_recovery` archive, account, golden, provider binding or task outcome
is deleted. A later ordinary send may resume one as ordinary work without a
legacy access-parent identity; coordinator should explicitly accept this behavior.

## Step-4 hard prerequisite: deploy code that no longer queries dropped tables

Before this schema draft can be approved, the step-4 implementation must remove
all owner-runtime workers/routes and old owner SQL. Shared `not exists(select 1
from orchestrators...)` checks must be removed or converted to generic
`armada_access_parents` compatibility fences, including:

- `packages/core/src/sandbox.ts`
- `packages/mcp-server/src/data.ts`
- `packages/mcp-server/src/resource-store.ts`
- `packages/mcp-server/src/model-usage.ts`
- `packages/mcp-server/src/sandbox-lifecycle.ts`
- `packages/mcp-server/src/mcp-lifecycle.ts`
- owner-only managed-parent preparation/model-auth code

Private delegated child gateway/executor/reconciliation and epoch bootstrap must
already have their independent #1002 composition and configuration. Deploying
only an owner-route tombstone is insufficient: old background lanes still query
or mutate the tables. Drain all old replicas before applying this migration.

## Disposable validation required before turning blueprint into a draft migration

No test or live database was used for this artifact. Required future tests:

1. Apply real prior migrations to disposable PostgreSQL; generate a populated
   legacy parent plus ordinary access parent. Establish confirmed stop evidence
   for all old compute, run candidate migration, verify all eight exclusive tables
   disappear and ordinary parent/epoch/child/cap rows survive byte-for-byte.
2. Independently leave each guarded condition active/unsettled; migration must
   roll back completely and leave all schema/data intact. Include orphan/mismatched
   generic identities and unknown preallocation receipts without child relation.
3. Verify normal user-JWT metadata read preserves org membership, owner/admin
   interior restrictions, outcome/preservation behavior; anon sees nothing.
4. Verify shared child ownership, parent owner/org/access/golden immutability,
   native replacement revocation and membership-removal revocation still work.
5. Run ordinary `--armada-access` launch/message/read/stop/extend plus revoked/
   stale-token/cap/uncertain-allocation fixtures against migrated schema.
6. Check schema dependencies with explicit DROP (no CASCADE). Unexpected dependent
   view/function/constraint must be investigated, not auto-dropped.
7. Regenerate `packages/core/src/database.types.ts`; remove only exclusive row
   aliases/exports/callers, retain generic/shared store types. Fresh full lint,
   strict typecheck, unit/SQL integration checks and independent review required.
8. Reconfirm timestamp uniqueness remotely and record operator-approved rollout,
   cleanup/provider inventory, encrypted backup and restore plan. Never apply the
   migration, execute cleanup, or change production from this coding session.

The explicit BEGIN/COMMIT requires review against the authorized migration runner's transaction boundary before application. No applied migration is edited.
