# Modal orchestrator recovery (#728)

After deploying the fix, use owner-authorized `armada orchestrator detail`
to inspect the current revision before each mutation. A completed idempotency
key replays its original receipt; a new recovery attempt needs a new key.

Do not edit SQL or delete Modal resources manually. Recovery must validate the
persisted provider ownership and incarnation before terminating compute.

## Recover the two reported orchestrators

Run as their Armada owner, after the updated server is deployed. Set the organization
ID (not a provider credential). Do not reuse the original failed **stop** key to
request recovery: that key only replays its immutable uncertain receipt.

```sh
export ORG='<Armada organization UUID>'
armada orchestrator detail ad7e39cb-da9c-4088-8fb9-31b55fff270e --org "$ORG" --json
armada orchestrator recover ad7e39cb-da9c-4088-8fb9-31b55fff270e --org "$ORG" --expected-revision 3 --idempotency-key recover-ad7e39cb-v1 --json
armada orchestrator detail ad7e39cb-da9c-4088-8fb9-31b55fff270e --org "$ORG" --json

armada orchestrator recover 52b264fd-6a22-4dd7-91ba-1f9358aae7c2 --org "$ORG" --expected-revision 1 --idempotency-key recover-52b264fd-v1 --json
armada orchestrator detail 52b264fd-6a22-4dd7-91ba-1f9358aae7c2 --org "$ORG" --json
```

Revision 3 is the revision reserved by the reported stop with expected revision 2.
The already-reserved create recovery must reuse its exact original revision 1/key.
If either detail differs from the reported state, stop and inspect its operations:
do not guess a revision or allocate another sandbox. An uncertain recovery retries
with the identical command; a completed recovery replays read-only.

These are destructive termination recoveries, not resumable checkpoints.
Expect parent `stopped`, continuity `unverified`, and the source uncertain
operation terminal (failed with `stop_recovered_terminated` or
`create_recovered_terminated`). No model account is resolved. The provider
checks the original create reservation, ownership tags, physical ID and generation
before terminating and requires positive exit evidence. Stop recovery is limited
to the original SQL/native generation 1, which is the reported case.

## Fresh create → send → stop → resume → stop smoke

Use an authorized Modal golden and Codex model account. Set these non-secret
resource IDs and an approved model ID; use a fresh run label each time.

```sh
export GOLDEN='<Modal golden UUID>' MODEL_ACCOUNT='<Codex account UUID>' MODEL='<approved Codex model>'
RUN="modal-728-$(date +%s)"
ID=$(armada orchestrator create "$RUN" --org "$ORG" --golden "$GOLDEN" --provider modal --agent codex --model "$MODEL" --model-account "$MODEL_ACCOUNT" --idempotency-key "$RUN-create" --json | jq -er '.orchestratorId')
armada orchestrator detail "$ID" --org "$ORG" --json
```

Create is asynchronous. Repeat detail until ready; if blocked, inspect events
instead of sending. Then execute each step only after the previous receipt is
succeeded; inspect detail/events until the sent turn has finished before stop.

```sh
revision() { armada orchestrator detail "$ID" --org "$ORG" --json | jq -er '.orchestrator.revision'; }
armada orchestrator send "$ID" 'Reply with exactly: modal-728-ok' --org "$ORG" --expected-revision "$(revision)" --idempotency-key "$RUN-send" --json
armada orchestrator events "$ID" --org "$ORG" --all --json
# After the turn finishes:
armada orchestrator stop "$ID" --org "$ORG" --expected-revision "$(revision)" --idempotency-key "$RUN-stop-1" --json
armada orchestrator detail "$ID" --org "$ORG" --json
armada orchestrator resume "$ID" --org "$ORG" --expected-revision "$(revision)" --idempotency-key "$RUN-resume" --json
armada orchestrator detail "$ID" --org "$ORG" --json
armada orchestrator stop "$ID" --org "$ORG" --expected-revision "$(revision)" --idempotency-key "$RUN-stop-2" --json
armada orchestrator detail "$ID" --org "$ORG" --json
```

Both stops must report stopped/native continuity; resume sends no extra prompt.
On transport uncertainty, replay the exact saved revision/key rather than calling
`revision` again. Do not run the remaining commands after an unsuccessful receipt.

## Offline evidence and diagnostics

The Modal SDK uses gRPC/HTTP2, not fetch. The recovery regression uses the real
SDK with its control-plane transport replaced; runner HTTP requests can use fake
fetch. No production credentials or live provider calls are needed. Tests reproduce
both interrupted cleanup phases and a checkpoint whose final acknowledged event
watermark advances after observation. These are confirmed defects, but the old
production log's generic conflict cannot prove which checkpoint guard fired.
Closed lifecycle diagnostic labels distinguish identity/observation, runner
checkpoint, scrub, snapshot, termination, receipt, and recovery binding failures
without logging upstream messages, tokens or checkpoint content.
