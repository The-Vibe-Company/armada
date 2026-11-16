# Historical turn model correction (#2433)

The released migration copied the launch default into historical queue entries,
although native follow-ups allow a per-turn override. The correction invalidates
those identities. Server startup decrypts durable inputs and repairs queue models
and outstanding reservations transactionally, before HTTP traffic or workers
start. Decryption failure aborts startup and rolls back repair; never bypass it.

## Deployment prerequisites

Use the normal validated release migration path. Quiesce all old server replicas
and queue workers before applying 20261116200000_repair_historical_turn_models.sql.
Keep API traffic stopped until a corrected server completes startup. Old binaries
must not run against invalidated identities: they still infer launch defaults.
New accounting conservatively counts unknown active/reserved models against every
model cap until reconstruction succeeds. Encryption keys never enter SQL or logs.

## Coordinator staging verification

On an isolated staging account, retain a running native per-turn override and a
queued override on sandboxes with a different launch default, plus an outstanding
reservation. After upgrade, enable a cap of one for the override model. Verify
usage attributes the running turn/reservation once to that model, the queued
override stays waiting, and unrelated launch-model work can start. Complete the
running turn and verify queued work admits under its original override. Confirm
startup prints neither decrypted inputs nor keys. Do not use Boat as a release
gate probe. No production evidence is claimed here.

## Rollback

Do not reverse the data migration by copying launch defaults again. If startup
fails, leave traffic/workers stopped and investigate the unreadable durable input
or encryption configuration through the normal owner recovery process. A binary
rollback is safe only after identity reconstruction has completed successfully;
the correction adds no schema columns and preserves the original durable inputs.
