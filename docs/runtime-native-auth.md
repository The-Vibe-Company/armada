# Native Codex publication from a Boat runtime (#1161, slice 8)

Originally stacked on event ingestion #1232 (now merged): this adds its previously
disabled nativeAuth branch. No migration or Modal publication/tunnel change. Boat launch opt-in,
checkpoint/stop integration and lifecycle/timing proof remain separate slices.

## Private publication

Configured shared-session launches now enrol directly through the subscription
broker on main. This endpoint remains only for an existing exclusive legacy/
compatibility native holder; it does not revive exclusive admission or accept
server-broker-managed state without that holder.

`POST /api/runtime/events` accepts the existing `{sandboxId,generation,events:[],
nativeAuth:{authJson,expectedRevision}}` envelope under Bearer runtime token and
`X-Armada-Runtime-Epoch`. It cannot be mixed with journal events; auth JSON is
bounded at 64 KiB and must match the existing Codex native-state shape. An
unconfigured publisher still returns 501 rather than a false journal ACK.

The runtime cannot choose an account. Current server sandbox binding supplies
owner, org, native `codex_auth` credential ID/version; the existing exclusive
subscription ownership row must still name this logical sandbox. Runtime epoch,
active membership/lifetime, harness and pinned credential binding are rechecked
in the same transaction that seals state. Wrong account identity never replaces
usable state. Revoked/replaced credentials do not receive a discard/scrub ACK.

Publication reuses `NativeStateStore.publish`, AES-GCM, identity checks, retired
secret registry and compare-and-swap revision semantics. A lost ACK can replay
identical auth without another revision; a stale different update receives only
`{authRevision,committed:false}`. Successful replies are
`{authRevision,committed:true}` with no-store; no auth JSON/token leaves are ever
returned. Raw credentials never enter the event archive or sandbox usage.
Source generation is `runtime:<epoch>`: this is not a legacy Boat SSH-quiesced
receipt and must not be used to claim checkpoint/stop proof.

The initial runtime binding probe releases its sandbox locks before any account
lock. Publication then locks member exclusively -> credential/ownership ->
verified runtime source -> model state. This avoids a sandbox/credential inversion
and a shared-member lock-upgrade cycle. The state store and epoch verifier reuse
one outer SQL transaction, never a second connection waiting for its own locks.
Only synchronous DB/crypto work occurs there, not provider/network operations.

## Coordinator staging check

After #1232's existing migration and this server are deployed, use a **dedicated
staging subscription account** and its idle disposable Boat Codex holder. It must
be owned by a current member, have no conversations/task prompt and be ready.
Never use an actual worker or production account: the diagnostic replaces runtime
authority. Set `ARMADA_STAGING_DATABASE_URL`, `ARMADA_STAGING_ENCRYPTION_KEY`,
`ARMADA_STAGING_URL` (HTTPS origin), `ARMADA_STAGING_SANDBOX_ID` and
`ARMADA_STAGING_OWNER_ID` through the secure environment, never argv/logs. Run:

```sh
ARMADA_RUNTIME_NATIVE_AUTH_SMOKE=use_disposable_staging_subscription bun scripts/smoke-runtime-native-auth.ts
```

Expected: current server-owned auth is read only into coordinator memory and
republished **unchanged** twice through the deployed endpoint; both receipts are
committed with the same revision. Epoch replacement rejects the old producer.
Only a fixed success/failure message is printed; no token, blob or leaf is written
to a file or returned by the diagnostic. No provider/harness/model call or OAuth
refresh is made. This verifies publication, not an actual subscription rotation.

The publication changes source provenance and invalidates the never-started
cleanup proof even for unchanged auth. Stop/delete the disposable holder through
the normal native-auth lifecycle and explicitly release/reconnect the dedicated
test account as needed. Do not repurpose the holder for real work afterward.

Worker tests use synthetic native state only. Real PostgreSQL regression holds
the credential while replacing lifecycle and proves publication neither holds
its sandbox waiting for that credential nor commits after epoch invalidation.
The deliberate unsafe sandbox-first variant deadlocks/fails; the correct order
passes. Full real Boat lifecycle, account cleanup/reconnect/checkpoint integration,
subscription refresh and >20% launch-regression checks remain for integration.
