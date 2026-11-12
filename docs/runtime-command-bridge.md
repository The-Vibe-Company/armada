# Durable HTTPS runtime command bridge (#1161, slice 5)

This slice mounts `/api/runtime/poll` and `/api/runtime/results` for the dial-out
client. WebSocket upgrade wiring, event/native-auth ingestion and Boat launch
opt-in are subsequent slices. An upgrade currently falls back to HTTPS. Do not
enable real harness launches before those remaining pieces and staging checks.
Modal is unchanged. No provider/model operation is performed by this bridge.

## Authority and storage

Only trusted server code calls `enqueue(ownerId, RunnerRequest)`; there is no
public enqueue/readback API. `withOwner` reuses enrolment's member -> sandbox ->
runtime-epoch lock order and requires the actual owner, current membership, an
active unexpired Boat sandbox and a live runtime grant. Each command records its
current epoch. Owner readback uses the same admission check.

Commands and result envelopes can contain secrets, so both are AES-GCM sealed
using the existing `ARMADA_ENCRYPTION_KEY`. `runtime_commands` has RLS and no
anon/authenticated grants (including its identity sequence). Rows cascade on
sandbox deletion; no new age-pruning worker is introduced in this slice.

Request IDs are unique for a logical sandbox across epochs. An identical retry
requires the same serialized request bytes and epoch; a changed payload or reuse
in another epoch is a conflict, never a new execution. Pending rows are delivered
in insertion order. Polling does not consume a row: unacknowledged commands are
redelivered with the same ID. Runner's local receipt/fence, not this mailbox,
protects harness side effects and may report `request_outcome_unknown` after a
crash. There is no exactly-once execution claim.

POSTs carry Bearer runtime token and `X-Armada-Runtime-Epoch`, and return
`Cache-Control: no-store`. Poll body is `{epoch}`; result is `{epoch,command}`
with a RunnerRequest or null. Empty polls revalidate every second for up to 20s,
releasing SQL transactions/locks while waiting and respecting disconnects. The
HTTPS client also checks `/api/runtime/session` independently every 20s (8s
deadline), including while a native command is blocked; explicit revocation uses
its existing native-driver abort/teardown path.
Results body is `{epoch,requestId,status,body}`; ACK is `{epoch,requestId}` only
after commit. The first result is immutable; duplicate completion is ACKed
without overwriting it. Unknown IDs or old-epoch results cannot commit.

New enrolment does not adopt old unfinished commands. With a new live epoch,
owner readback labels those `superseded`; completed historical replies remain
readable by that active owner. The future provider adapter must surface unknown
outcomes, not silently reissue side-effecting work with a fresh ID. Native request
and HTTP result sizes are bounded at 1 MiB and 2 MiB respectively; command
admission includes HTTP/WSS envelope bytes so a queued head cannot exceed the
client frame ceiling.

## Coordinator staging check

1. Recheck migration ordering on current main before merge, then apply
   `20261112140924_runtime_commands.sql` to **staging only** via the normal
   migration process before deploying this server. The worker applied migrations
   only to disposable local test databases, never staging/production.
2. Select a disposable active Boat sandbox owned by a current org member. Never
   use an actual worker's sandbox: the diagnostic replaces runtime authority.
3. Provide `ARMADA_STAGING_DATABASE_URL`, `ARMADA_STAGING_ENCRYPTION_KEY`,
   `ARMADA_STAGING_URL` (HTTPS origin), `ARMADA_STAGING_SANDBOX_ID` and
   `ARMADA_STAGING_OWNER_ID` through the coordinator's secure environment.
4. Run:
   ```sh
   ARMADA_RUNTIME_COMMAND_SMOKE=use_disposable_staging_sandbox bun scripts/smoke-runtime-commands.ts
   ```
   Expected: deployed poll returns the same queued ID twice; synthetic result and
   repeated ACK survive owner readback; a replaced epoch rejects the old client.
   This is explicitly a **synthetic mailbox protocol** smoke, not evidence of a
   native harness executing a command. The worker also ran it over actual loopback
   TLS routes and disposable PostgreSQL 16; unit coverage composes the real
   dial-out client, Runner and this bridge without sockets.
5. Stop/delete the disposable sandbox afterward to clear the final unused ticket.
   No harness/model/provider call is made by the diagnostic. Full compiled-native
   Boat lifecycle, WSS transport and cold/cache/resume timing (>20% owner decision)
   checks remain for the integration slices. Never put secrets in argv or logs.
