# Modal orchestrator recovery (#728)

After deploying the fix, use owner-authorized `armada orchestrator detail`
to inspect the current revision before each mutation. A completed idempotency
key replays its original receipt; a new recovery attempt needs a new key.

Do not edit SQL or delete Modal resources manually. Recovery must validate the
persisted provider ownership and incarnation before terminating compute.
