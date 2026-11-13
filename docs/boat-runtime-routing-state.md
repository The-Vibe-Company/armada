# Durable Boat runtime selection (#1161)

This slice adds `sandboxes.boat_runtime`, default **false**, as a server-owned
per-launch routing decision. It is not proof of enrolment, readiness or prompt
execution. Existing Boat sessions remain native; Modal is unchanged. No public
launch flag is accepted/enabled by this change.

Only a new Boat/Codex row can select true. Selection is immutable after insert,
including for service-role writers: never relabel an existing native conversation
or silently fall back to the native runner after a runtime bootstrap failure.
Claude/runtime default-on/old-session retirement remain later programme steps.

`SandboxStore.insert` and the scoped server store accept trusted `boatRuntime:
true`; both persist and return it. Core cleanup reads and scoped interior reads
retain it across lifecycle state changes. `SandboxRecord.boatRuntime` is optional
and readonly; false/native values are omitted to preserve existing DTO shape.
It is deliberately absent from `SandboxPatch` and user-JWT write grants.

Authenticated users can select the non-secret metadata only under existing RLS;
no anonymous or authenticated insert/update privilege is added. The default
makes legacy inserts safe. Generated database types include the schema column.

## Coordinator check and rollout

The new migration is `20261112235447_boat_runtime_selection.sql`. It must be
applied to **staging by the coordinator before deploying code that reads the
column**. The worker generated types/tested migrations only in disposable local
PGlite, never a remote database. Existing schema-readiness/build checks require
current migration history. Recheck uniqueness/newness against main before merge;
fresh SQL tests do not verify remote history.

Zero Boat starts needed for this slice:

```sh
bun test packages/mcp-server/test/runtime-routing-state.test.ts
```

Expected: native inserts retain false/unchanged DTOs; both trusted store paths
retain explicit true through stop/readback; service writes cannot flip either
choice; Claude/Modal opt-ins are refused; user JWTs can only read scoped metadata.
Tests use migrated local SQL and first prove a normal Modal insert works, so an
unrelated provider/alias guard cannot mask target validation.

Still required for ONE real Boat answer: connect explicit per-launch API/CLI
selection, startup/configuration/agent ports and lifecycle cleanup/read routing.
Do not expose a flag that only sets this column and then calls Boat's native
prompt API. The exact one-launch coordinator check follows when main supports it.
