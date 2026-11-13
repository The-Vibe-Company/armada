# Persisted-sandbox-bound Docker jobs (#1165)

This internal bridge derives machine requests from persisted Docker rows, not
caller-selected image/generation/host/expiry fields. It does not create rows or
enable a public launch/provider/Hosts API. Legacy administrative unbound jobs
retain their previous format and authorization; managed placement must use the
bound path, never expose the unbound enqueue method as an end-user API.

## Admission and delivery

Current owner-members may create/bootstrap. Owner or current org admin may
stop/delete; membership and actor epochs come from SQL, not caller role claims.
Source actors lock in UUID order before host, sandbox and job. Host registration,
installation/org binding and the immutable physical identity are revalidated.
Only the requesting action, request ID and opaque bootstrap descriptor are inputs.

Private bound-job metadata records sandbox, actor, actor epoch and operation.
Create/bootstrap each have one immutable phase admission per sandbox. Existing
IDs cannot change body, host or bound identity. Bound ciphertext uses a private versioned envelope; older strict servers cannot
silently deliver it as unbound work. The host wire job is unchanged.
Before delivery, the queue locks
the hinted parties and rechecks the same head; it never acquires a new actor
lock after a head change. Revoked/stale or ineligible bound heads fail terminally,
so a later authorized cleanup is not permanently blocked behind them.

Bootstrap needs acknowledged creation and a current pending ticket for this
exact logical sandbox. Ticket validation occurs under the existing runtime
authority; no model/configuration values enter the machine queue. Delivery must
permit saved ACK reconciliation after a ticket was consumed, not mistake that
normal replay for another execution. The host's durable one-use fence still owns
actual bootstrap replay protection.

Later phases use the original admitted create descriptor, even if SQL logical
expiry was shortened. They cannot retarget a different generation or silently
extend its absolute lifetime. Stop intent is committed with its runtime fence
before physical delivery. Host completion is a machine fact, not fresh authority:
ACK is retained even if the requesting actor later left. Stop/delete ACKs settle
their permitted logical states; create/bootstrap ACKs do not claim readiness.

## Producer and scope contract

A higher-level creator still owns row reservation and full launch idempotency.
When composing inside an outer transaction, prelock all affected memberships
exclusively in UUID order before inserting/updating the sandbox; do not upgrade
membership locks after taking a sandbox/host lock. No managed create admission
means no managed machine allocation may be inferred.

No default TTL or host credential policy change; no quota, goldens, resume,
Hosts UI or gVisor. Runtime prompts/events/credentials remain on its own dial-out
channel. Public launch orchestration, readiness/prompt/journal and final
coordinator SSH install/register/one-prompt smoke remain subsequent work.

## Exact coordinator checks

No worker deployment, remote migration, real host or inference used. Locally:

```sh
bun test packages/mcp-server/test/docker-host-store.test.ts packages/mcp-server/test/docker-host-routes.test.ts packages/core/test/database.test.ts
bun scripts/db/check-migrations.ts origin/main
```

Expect SQL-derived immutable machine requests, caller epoch/permission fences,
invalid-head retirement, ticket binding, logical stop/ACK and frozen-expiry
cleanup to pass on disposable migrated PGlite without sockets or sleeps.
Existing registration/unbound/HTTP behavior must remain green.

After the normal coordinator STAGING-only migration, use secure libpq environment
(no credentials in argv) to inspect docker_host_jobs bound metadata columns and
the create/bootstrap uniqueness index:

```sh
psql -X -v ON_ERROR_STOP=1 <<'SQL'
select column_name,data_type,is_nullable from information_schema.columns
 where table_schema='public' and table_name='docker_host_jobs'
 and column_name like 'bound_%' order by column_name;
select indexname,indexdef from pg_indexes
 where schemaname='public' and tablename='docker_host_jobs'
 and indexname='docker_host_jobs_bound_phase';
SQL
```

Expect four nullable metadata columns and one unique partial phase index.
All server instances must be upgraded before creating bound work. Do not roll
back while it remains queued; old readers deliberately refuse the envelope.
This is not real Docker/Codex proof.
