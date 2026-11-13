# Staging smoke sandbox cleanup

Coordinator-only: coding workers do not access staging.

## Recurring smoke

The staging workflow sets `ARMADA_SMOKE_JOURNAL` to a durable JSON receipt artifact.
Every successful direct/template launch records its exact sandbox ID before the
probe validates other fields. Verified scoped-child stop handles are also recorded.
Deletion follows all probes, including failures; existing stop, recovery and expiry
assertions run first. Deletion must return the exact ID and `status: deleted`.
The final `smoke_cleanup_summary.remainingRows` target is **zero**. Soft-deleted
audit records remain in the database, but disappear from active lists.

A bounded parallel sweep (32 receipts) retries earlier known leftovers; the final
sweep handles up to 64 receipts. Failed/unattempted receipts stay in the journal.
Never enumerate "all stopped" or identify candidates by shared golden or owner.
Lost launch responses are reported as unknown, never falsely claimed as cleaned.
Direct launch has no idempotency lookup: the coordinator must reconcile unknown
launches before claiming zero growth. Forced termination before receipt persistence
has the same limitation. Journal cleanup refuses `--orchestrator` before compute:
managed parents/children cannot be deleted through the ordinary sandbox API.
The default staging matrix does not enable this mode.

## Historical cleanup plan

1. Recover an explicit ID manifest from trusted smoke execution receipts. Each
   entry is `{ "requestKey": "post-deploy-smoke:<UUID>", "org": "<staging org>",
   "id": "<sandbox UUID>" }`. The key labels the original smoke request in the
   audit manifest; it is **not** a server-side sandbox label. Keep its source run
   URL alongside the manifest. Never manufacture attribution from stopped status,
   age, owner or golden. Old direct launches did not persist labels: without
   trustworthy receipts, stop and request coordinator attribution.
2. Set `ARMADA_URL=https://armada-mcp-staging.up.railway.app`,
   `ARMADA_SMOKE_ORG=<exact staging org from receipts>` and
   `ARMADA_SMOKE_JOURNAL=<manifest path>`. No token is needed for dry-run.
3. Run `bun scripts/cleanup-staging-smoke.ts`. Inspect candidate counts and source
   receipts. Wrong origins (including production) and mixed-org manifests are
   refused before requests.
4. Set `ARMADA_TOKEN` through the staging secret store, then run
   `bun scripts/cleanup-staging-smoke.ts --delete`. At most 32 explicit IDs are
   attempted per invocation. Counts are printed; failures return nonzero. Preserve
   the source manifest and partition into batches of 32. Already-deleted IDs can
   safely be repeated. Never paste tokens into argv or logs.
5. Compare the staging org's visible sandbox count before/after. Run an ordinary
   staging smoke, check all deletion steps and final count zero, then confirm the
   visible count did not grow. No deployment or migration is part of this script.

Offline checks: `bun test scripts/smoke-sandbox-cleanup.test.ts scripts/cleanup-staging-smoke.test.ts`.
Coordinator checks: deliberately fail a probe after launch; restore a journal with
one known leftover on the next run; verify unrelated stopped sandboxes survive.
