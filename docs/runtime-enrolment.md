# Boat runtime enrolment and epoch authority (#1161, slice 3)

This independently mergeable slice adds the private server authority used by the
future opt-in Boat launch. It does not deliver tokens to Boat or enable a launch,
change Modal, or implement the dial-out channel. No model call/host compute is
needed to verify it. Previous compiled/cache PRs are not code dependencies.

## Contract

The internal launcher calls `createRuntimeEnrolments(sql, key).issue` with the
logical sandbox, owner and trusted bootstrap configuration, freshly resolved on
every start/resume. Only an active, unexpired Boat sandbox whose owner is still
an organization member is admitted. There is no public token-issuance endpoint.
A new issue immediately revokes prior pending/live runtime authority.

The host must deliver **only** the returned single-use enrolment token via private
stdin; never configuration/model credentials or tokens in argv, logs or goldens.
The runtime exchanges it with `POST /api/runtime/enrol`, passing it as a Bearer
header. The five-minute ticket is consumed in a database transaction. The response
contains `{sandboxId, epoch, runtimeToken, configuration}` with `Cache-Control:
no-store`. This is a capability-protected private runtime endpoint, not a user API.
Lost exchange responses require a new trusted issuance; consumed tickets cannot
be replayed. An invalid/expired/replayed capability returns constant 401 JSON;
infrastructure/decryption failures return constant 503 JSON without driver text.

Configuration (up to 1 MiB) is sealed with the existing AES-GCM scheme and
`ARMADA_ENCRYPTION_KEY` while pending and cleared on successful exchange. Tokens
are stored only as SHA256 hashes. The table has RLS and no anon/authenticated
grants. Model credentials are never returned by session validation.

Each successful exchange increments the durable sandbox epoch. Runtime requests
must supply both their runtime token and `X-Armada-Runtime-Epoch`.
`POST /api/runtime/session` validates these and returns only sandbox/epoch.
Future channel handlers must use `withSession` to hold the SQL epoch fence through
journal/command mutations, rather than checking a token before an unrelated write.
No provider/network operation belongs inside that short transaction. Admission locks
member, then sandbox, then runtime, matching membership revocation lock order.

Lifecycle replacement, stop admission/completion, failure/deletion and membership
removal clear pending/live capabilities. Restoring a ready status or re-adding a
member cannot resurrect cleared tokens. The row/epoch remains for the sandbox's
lifetime; the existing provider/owner identity guards remain authoritative.

## Coordinator staging check

1. Apply `20261112120000_runtime_enrolments.sql` **on staging only**, using the
   normal migration process before deploying this server. The worker did not
   apply any remote migration or deploy anything. Recheck the migration version
   against current main before merge (it must remain strictly newer).
2. Select a disposable active Boat sandbox in staging, owned by a current org
   member. Do not use a real worker's sandbox: the diagnostic replaces its
   private runtime authority, though it does not touch Boat's native runner.
3. Set these environment variables through the coordinator's secure environment:
   `ARMADA_STAGING_DATABASE_URL`, `ARMADA_STAGING_ENCRYPTION_KEY`,
   `ARMADA_STAGING_URL` (HTTPS origin), `ARMADA_STAGING_SANDBOX_ID` and
   `ARMADA_STAGING_OWNER_ID`. Never put their values in command arguments/logs.
4. From the current checkout, run:
   ```sh
   ARMADA_RUNTIME_ENROLMENT_SMOKE=use_disposable_staging_sandbox bun scripts/smoke-runtime-enrolment.ts
   ```
   Expected: the running server exchanges each ticket once, rejects replay, accepts
   the current epoch and rejects both an old token and an old epoch after the
   second exchange. The script prints only a fixed success/failure diagnostic.
5. Stop/delete the disposable sandbox normally after the check. That revokes the
   diagnostic's last capability. Full Boat lifecycle/timing validation follows
   when the enrolment client, dial-out channel and launch wiring are delivered.
