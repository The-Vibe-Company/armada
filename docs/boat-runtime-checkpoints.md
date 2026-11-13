# Boat runtime checkpoint before stop (#1161)

This is the stop/resume **foundation**, not resume support. The initial staging
prompt is already proven. Follow-up prompts are a separate preceding slice.
The Boat native path and Modal behavior stay unchanged.

## Contract

`POST /api/v1/sandbox/checkpoint-runtime-v1` (MCP: `runtime_checkpoint`) takes:

```json
{"id":"SANDBOX_UUID","request_id":"OPERATION_UUID","runtimeVersion":1}
```

Only the sandbox owner with current membership can request it. It never resolves
a native host/provider or model credential, and never starts compute. A durable
same-epoch intent prevents new `send` admissions. An in-flight admission must
settle first. The runtime interrupts active work, waits for native completion,
closes drivers, flushes the journal outbox and seals its private harness state.
Only a matching encrypted durable command result and the **exact acknowledged
archive prefix** produce a complete receipt:

```json
{"runtime":{"kind":"armada","epoch":"1"},"checkpoint":{"state":"complete","watermark":20,"acknowledgedSequence":20}}
```

No journal events are fabricated. A different generation, missing ACK, prefix
gap or late journal tail fails closed. Application-secret exposure forbids reuse.
The receipt is immutable; repeat the same request UUID on uncertainty. A server
restart can reconcile the durable result even after compute stopped, without
waking the guest. A new UUID cannot replace an unresolved intent in that epoch.
The intent remains fenced after failure; stop/inspect rather than issue new work.

This operation **does not stop the VM**, create a Git work archive or prove host
disk retention. Follow it with ordinary `sandbox/stop`. Raw stop without this
operation still performs compute cleanup, but does not claim a checkpoint.
Stop preservation notes recognize a complete, same-current-epoch receipt only
when the final archive prefix still matches, after stop fencing. Physical stop
must separately be confirmed. An old receipt is not authority for a new epoch.

## Exact ONE-launch staging check

After this slice's migration `20261113034000_runtime_checkpoints.sql` and server
are deployed (coordinator only), from updated main with existing staging env:

- `ARMADA_URL`: armada-server HTTPS origin, **not dashboard**
- `ARMADA_TOKEN`: bearer supplied through environment, not arguments/logs
- `ARMADA_RUNTIME_ORG`: org **UUID**, not name/slug
- `ARMADA_RUNTIME_GOLDEN`, `ARMADA_RUNTIME_CREDENTIAL_ID`
- Optional `ARMADA_RUNTIME_MODEL`

```sh
ARMADA_RUNTIME_SMOKE=one_real_boat_launch bun scripts/check-boat-runtime.ts --checkpoint
```

Preflight requires `boatRuntime.checkpointVersion:1` before allocating. It makes
ONE sandbox launch, verifies initial and memory-retaining follow-up answers in
the same conversation/epoch, prints a safe checkpoint request UUID, obtains the
complete watermark/ACK receipt, stops compute once, then reads the same receipt
and both prompts' archive history while stopped. Expect `checkpoint:"verified"`
and `Runtime checkpoint and stopped history verified; resume not implemented yet.`
No allocation retry. The normal server image publishes pinned artifacts (#1325);
there is no separate artifact publication step.

The stop/resume milestone is **not complete** after this check: no runtime resume
endpoint is added here. The next slice must require valid current checkpoint
proof plus confirmed retained stop, reauthorize the pinned model connection,
activate the same VM, enrol a new epoch and prove memory/history continuity.
It must reject missing/mismatched checkpoint state rather than replay a prompt
or fall back to Boat's native runner. Do not repeat this start just for the
foundation if the coordinator prefers the later combined lifecycle check.

Explicit new-epoch activation is now defined in [Boat runtime resume](boat-runtime-resume.md).
The combined `--resume` check supersedes a separate checkpoint-only start when
conserving staging quota. Bare `send` still never implicitly resumes runtime VMs.
