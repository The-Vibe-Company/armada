# Runtime event ingestion (#1161, slice 6)

`POST /api/runtime/events` accepts the existing runtime Journal batch. This slice
adds only durable event ingestion and the existing ordinary-sandbox usage
projection. It does not wire Boat launch opt-in, expose a new history API, or
change Modal. Server WSS upgrade and native-auth publication remain separate
slices; nativeAuth envelopes are explicitly rejected with 501, never ACKed as
credential publication. Do not enable subscription launches before that hook.

## ACK and privacy contract

The Bearer runtime token and `X-Armada-Runtime-Epoch` are checked through existing
`withSession`, holding member -> sandbox -> runtime locks until commit. JSON
`sandboxId` and `generation` must match that authenticated scope, not select it.
The entire request is bounded at 1 MiB, with at most 1,000 events. Per-event
serialized length uses Journal's existing 262,144 UTF-16-code-unit limit, not a
narrower UTF-8 byte cap; legitimate multibyte events still fit the 1 MiB batch
boundary. Common AgentEvent shapes and safe positive sequences are checked.

The encrypted `runtime_events` table is service-only (RLS, no anon/authenticated
grants). Raw events, including account/quota metadata, are AES-GCM sealed with
`ARMADA_ENCRYPTION_KEY`; no user JWT or new public API can read the archive.
Future history integration must retain existing visibility checks and private
model-event filtering before exposing decrypted events to sandbox audiences.

One logical sandbox owns one persistent producer sequence across start/resume
epochs. Its private journal/directory must survive stop/resume. The primary key
is `(sandbox_id, sequence)`, not epoch: a fresh epoch may replay identical events
whose ACK was lost, but cannot rewrite them. Object key order is canonicalized;
array order and values remain meaningful. A new empty journal must never reset
an existing sandbox's sequence—conflicting/missing history fails closed, not by
inventing an offset or guessing counters. Forked goldens must have empty history.

Batches are ordered by producer sequence; only their contiguous prefix commits.
A gap returns the last durable sequence and publishes nothing beyond the gap.
Conflicting replay aborts the whole transaction. ACK is emitted only after the
encrypted archive **and** applicable usage projection commit; lost ACKs can be
retried. Rows cascade on hard sandbox deletion; no age-pruning job is added here.

Usage reuses `reportedTurnUsage` and the server data layer's `recordUsage` merge;
there is no Boat event mapper, new pricing table or token estimate. Non-secret
logical prompt IDs have one sparse private marker per turn (not a full prompt
lookup index), including usage-only reports. This counts cumulative distinct
prompts without scanning all message events, so
unmeasured/failed turns in earlier batches are not lost. Known counts
remain known, missing figures remain null. Private account/quota payloads are not
projected into sandbox usage. Managed parents retain their existing journal-only
usage writer; their encrypted events can still be archived. Native-auth state
must use the later dedicated ownership/publication hook, not event payload data.

## Coordinator staging check

1. Recheck migration ordering against fresh main and apply
   `20261112185118_runtime_events.sql` on **staging only** through the normal migration process
   before deploying this server. The worker applied no remote migration/deploy.
2. Select a **fresh, disposable, active Boat sandbox** owned by a current member,
   with no runtime_events archive. Never use a real worker: the diagnostic
   replaces runtime authority and writes synthetic usage into this resource.
3. Set `ARMADA_STAGING_DATABASE_URL`, `ARMADA_STAGING_ENCRYPTION_KEY`,
   `ARMADA_STAGING_URL` (HTTPS origin), `ARMADA_STAGING_SANDBOX_ID` and
   `ARMADA_STAGING_OWNER_ID` via the secure coordinator environment, never argv.
4. Run from the current checkout with Bun/workspace dependencies installed:
   ```sh
   ARMADA_RUNTIME_EVENT_SMOKE=use_disposable_staging_sandbox bun scripts/smoke-runtime-events.ts
   ```
   Expected: deployed endpoint ACKs sequence 1 twice; one encrypted row and one
   usage snapshot exist; replacing the epoch rejects the old producer. Only a
   fixed success/failure message is printed. These are **synthetic protocol
   events**, not evidence of a harness call, usage measurement or Boat lifecycle.
5. Stop/delete the disposable sandbox to clear the final unused ticket. Full
   native/Boat lifecycle, subscription refresh, WSS and cold/cache/resume timing
   (>20% owner decision) checks remain for the integration slices.
