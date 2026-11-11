# Orchestrator server retirement — PREPARED ONLY

Do not deploy this draft until the coordinator explicitly opens step 4 of #984.
Prerequisites: #1002 scoped sandbox access verified on staging for Boat × Codex
and Modal × Codex, the iPhone build without orchestrators published, and every
legacy owner's parent AND child compute stopped using the retained API.
Step 5/database deletion is separate and still gated.

## Before deploying tombstones

Run scripts/retire-orchestrators.ts against the OLD retained Armada 2.21 API.
This is a pre-deploy tool, not a stop endpoint after retirement. Supply the owner's
ARMADA_TOKEN environment or --token-stdin; never argv. Never save tokens in a plan.

    bun scripts/retire-orchestrators.ts --origin https://APPROVED_ORIGIN \
      --owner USER_ID --org ORG_ID --plan /private/path/retirement-plan.json
    # Review the dry-run plan, all paginated parents and all linked child status reads.
    bun scripts/retire-orchestrators.ts --origin https://APPROVED_ORIGIN \
      --owner USER_ID --org ORG_ID --plan /private/path/retirement-plan.json \
      --apply --confirm-owner USER_ID

Dry-run is default and dispatches no stop. It includes blocked parents and their
pending/uncertain operation states rather than hiding compute from inventory.
Apply refuses any such plan before saving or dispatching stop state; resolve the
original exact receipt in pinned Armada 2.21 without replacement keys.
A plan contains only scope, identities,
status/revisions, stable stop keys and receipt IDs; no prompt, credential or grant.
The script refuses to overwrite a prior plan. Apply fsyncs planned keys/revisions
before dispatch, stops children then parents, polls exact receipts, and rechecks
owner inventory. An uncertain/missing/failed/pending receipt fails closed.
Do not recreate parents or invent replacement keys. Use a pinned Armada 2.21
recovery environment with the exact saved owner, revision, key and receipt.
A dispatched request without a known receipt is not automatically reissued.
Verify physical exit with provider/operator evidence independently: a logical
stopped API row alone does not prove provider compute billing is released.

Inventory is owner-scoped, NOT global. An authorized operator must inventory all
owners and repeat under each authorized identity. A single empty list does not
prove the org/fleet has no compute. Re-inventory immediately before deployment;
new resources invalidate the plan.

No archive, checkpoint, disk, logical identity, conversation or history is deleted.
Provider retained disks may still incur storage cost. Only separately confirmed
machine stops release active compute. No child compute closure claim is valid
until every linked child and final inventory is checked. If cleanup cannot settle,
do not deploy tombstones: retain the old API.

## Scoped sandbox replacement and deployment configuration

ARMADA_SANDBOX_ACCESS_PAIRS=boat:codex,modal:codex is explicit and default-off.
The retired ARMADA_ORCHESTRATOR_PAIRS and ARMADA_ORCHESTRATOR_SKILL_REVISION
settings no longer enable anything. Configure the new setting deliberately only
after staging verification; do not infer pairs from client input.

Opted-in ordinary sandboxes retain private authority/epoch/native hooks, child
broker/reconciliation and internal armada_orchestrator gateway name. They do not
require an owner runtime, create queue, idle/wait policy or event worker. See
[Sandbox Armada access](sandbox-armada-access.md).

Authenticated public /api/v1/orchestrators and all suffixes, including settings
and waits, return HTTP 410 with removed guidance pointing to #1002. Unauthenticated
callers keep the existing refusal. Shared tables remain; no migration is applied.

## Preparation limits

This draft is not an authorized rollout or provider/staging validation. Owner-only
modules and exclusive tests require a final deletion audit; shared modules must
not be removed by filename. Cleanup tests must prove pending/uncertain outcomes do
not replay. Coordinator owner-go and cleanup evidence are required before shipping.
The database PR separately enumerates destroyed data and preserved contracts.
