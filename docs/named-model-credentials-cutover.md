# Named model credential cutover (202)

This is an operator-run maintenance cutover, not a rolling old/new deployment.
Do not apply `20261110120200_named_model_credentials.sql` during PR review.
The author must not migrate, merge, stop production, or deploy from this work.

## Concrete old production target

The old-schema control API/MCP service is
`https://armada-mcp-production.up.railway.app` (including `/api/v1/` and `/mcp`).
Its Railway production environment is
[project c2f9ded9 / production 44fcca41](https://railway.com/project/c2f9ded9-2646-402d-9f7d-6048b2dde383?environmentId=44fcca41-792d-44a1-98dc-3baf2fc40575).
At the 2026-11-09 audit checkpoint, GitHub's latest successful Railway deployment
record was **7657005937**, revision
**405d15a95269b20cc222d042861608503149e4dc**. The previously reported
`c00cb3be2f1d919792ea6e92e699aa10dc9d69be` deployment (record 7655481178)
was marked inactive. These are GitHub deployment records, not invented Railway
deployment IDs, and an inactive GitHub status is not proof that replicas stopped.
Refresh the live Railway inventory before the maintenance window: newer builds
may still use the old schema/writer. Identify the Railway deployment(s) by these
commit revisions and the public service above; inventory every running replica
and background worker, including replacements started after this checkpoint.

Old binaries issue unconditional `ON CONFLICT (scope, owner_id, kind)` writes.
202 removes that unique constraint; the provider-only partial index does not
satisfy the old unconditional conflict target. Old writes fail even before any
duplicate account exists. Old readers also cannot honor named account defaults,
IDs and versions, and old service-role deletion can erase model account history.
The new authenticated model INSERT/UPDATE/DELETE fences intentionally reject
legacy direct user-JWT writers. **Do not leave any old writer running across202.**

## Required order and release gates

1. **Close credential/named-write entrypoints and drain in-flight requests.**
   Coordinate the public dashboard/CLI write UI with the backend maintenance
   window. Do not allow old credential actions to keep issuing writes while
   schema and backend versions differ. The independently deployable #621 public
   proxy fix is not permission to open named writes or apply202.
2. **Drain and remove/stop the old production Railway deployments before202.**
   Target the service/environment/revisions identified above, including all
   replicas and `armada-server` background workers. Stop old automatic restart
   or redeployment from resurrecting an incompatible writer during cutover.
   Traffic removal alone is insufficient: confirm zero running old-revision
   processes/deployments in Railway. Record the actual deployment IDs and drain
   evidence in the release log. `/healthz`'s package version alone cannot identify
   the code revision and is not drain proof. Keep maintenance in place until the
   old deployments are gone; do not rely on rolling deployment overlap.
3. **Only after that drain, the integration operator applies202 once.**
   Preserve `ARMADA_ENCRYPTION_KEY`; do not rotate encryption keys during this
   migration. Existing account UUIDs/ciphertext remain unchanged; historical
   harness preference is migrated to explicit defaults. Authenticated users may
   still read safe metadata but cannot directly insert/update/delete model rows.
   Provider Boat/Modal writes retain their existing owner/admin rules and
   singleton identity. Canonical account mutations use the service-role API.
4. **Deploy the new backend before the #618 Credentials UI.**
   Use the reviewed #603 account/pinning implementation, and include the #617
   owner-authorized legacy binding recovery API before allowing legacy Modal
   workspaces to resume. Verify the new backend's exact commit/artifact, all
   replicas and workers, encryption configuration, account routes, explicit CAS,
   source pinning and safe error DTOs. No old binary may remain in the pool.
   Routine native OAuth refresh uses its separate auth revision, not account
   replacement version changes. No automatic default adoption for legacy work.
5. **Deploy #618, then verify backend and frontend together before reopening.**
   The UI must use account UUID/control routes, safe DTOs and explicit secret
   revision CAS, not user-JWT model writes or the removed kind upsert target.
   Confirm authenticated default-public-origin transport (the #621 allowlist),
   duplicate same-kind accounts, personal/org defaults, explicit selection,
   rename without secret rotation, successful expected-version replacement and
   stale-version conflict with no overwrite. Confirm a legacy owner can stop
   safely, choose an account explicitly, retain workspace/conversations, and
   resume without silently selecting a new billing default.
6. **Reopen named writes only after BOTH new backend and #618 are ready.**
   Record that gate explicitly; one healthy deployment is not enough. Monitor
   permission, conflict-target and authentication errors without logging values,
   tokens or ciphertext. Do not re-enable an old deployment as a quick rollback.

## Failure/rollback rule

If any gate fails, keep writes closed and roll forward a compatible backend/UI.
Do not restore the old conflict target by deleting duplicate accounts, and do not
roll back to the old binary against202. A database rollback requires a separate,
operator-approved backup/restoration plan that preserves encrypted data, account
identity and billing history. This document authorizes no live operation.
