# Persistent orchestrators from the CLI

`armada orchestrator --help` lists the commands without requiring login. Other
commands use the existing Armada login or `ARMADA_TOKEN`, never provider or
database credentials. Use opaque organization, golden and model-account IDs.

```sh
armada orchestrator capabilities --json
armada orchestrator create reviews --org ORG --golden GOLDEN --provider boat \
  --agent claude --model MODEL --model-account ACCOUNT --repo web \
  --size medium --idle-seconds 7200 --idempotency-key CREATE_KEY --json
armada orchestrator list --org ORG --json
armada orchestrator detail ID --org ORG --json
armada orchestrator send ID 'Review the next issue' --org ORG \
  --expected-revision 7 --idempotency-key MESSAGE_KEY --json
armada orchestrator steer ID 'Focus on the failing check' --org ORG \
  --expected-revision 8 --idempotency-key STEER_KEY --json
armada orchestrator stop ID --org ORG --expected-revision 9 --idempotency-key STOP_KEY
armada orchestrator resume ID --org ORG --expected-revision 10 --idempotency-key RESUME_KEY
armada orchestrator events ID --org ORG --cursor CURSOR --follow --json
```

These examples describe requests, not an enabled runtime. The server controls
availability and authorization. A disabled capability or `unavailable` response
is not functional success. Native stop/resume requires server-side conformance;
the CLI never sends a synthetic prompt to simulate resume. No public wait or
private delegated-callback command is provided.

## Choices and defaults

Choose `claude` or `codex`, model, optional reasoning effort and a named account.
The server authorizes the selections and preserves native continuity. Omit
`--size` to use the server's selected-repository, golden, then legacy defaults;
an explicit canonical size overrides them. The CLI does not calculate resource
policy or infer capacity from a size label. Idle period is optional, in seconds;
server defaults apply when omitted. No default child limit, daily-start quota or
provider pacing is sent.

## Receipts, errors and reconnect

Every write requires a caller-chosen key. Keep the exact key and arguments for
recovery after an uncertain response; never generate a fresh key to retry an
unknown allocation. Surrounding spaces are rejected because HTTP would trim them.
Mutations also require the revision from detail/events. Do not replace it with a
new revision while recovering an existing operation. The server decides receipt
replay and conflicts. A receipt can be pending, succeeded, failed or uncertain;
admission alone is not completion. Failed/uncertain receipts exit nonzero.

JSON responses remain JSON. Errors are JSON on stderr with a nonzero exit code.
Events emit **one complete JSON page per line**, including the server cursor and
unknown event kinds. `--all` drains available pages; `--follow` continues polling.
On interruption or a failed poll, reconnect with the last delivered cursor.
Delivery is at-least-once across an interruption: deduplicate by event ID if a
page must be replayed. Cursors are opaque; never substitute provider cursors.
Polling is read-only and does not keep a runtime active.

## Recover a never-conversed Modal create

`armada orchestrator recover ID --org ORG --expected-revision ORIGINAL_REVISION
--idempotency-key RECOVERY_KEY --json` is a narrow owner recovery, not a generic
retry. It aborts an original pending/uncertain first create, with or without a
registered parent sandbox. It discovers its exact private Modal resource,
terminates/confirms it through Armada's fenced provider path, and publishes a
stop-kind receipt only after positive terminal proof. It never allocates a
replacement or requests model-account values. Keep the original key and revision
for reconciliation; do not generate new keys after uncertainty. A manual replay
of an unconfirmed recovery may idempotently terminate the exact same fenced
physical resource again; a successful receipt replay is read-only. No automatic
CLI retry or new allocation is performed. See
[troubleshooting](orchestrator-troubleshooting.md) for scope, proof requirements
and safe retry limits. A successful recovery keeps history and clears the old
create's busy fence, allowing a later ordinary stop; it does not invent native
continuity for a never-started conversation.

For automation in separate tool shells, prefix `ARMADA_URL` on each command rather
than relying on a prior shell export. The default public origin uses the dashboard
control proxy; its deployment must include the same owner routes as the backend.
Unstructured HTTP errors report the validated effective origin without echoing
upstream bodies or credentials. See [404 diagnosis](orchestrator-troubleshooting.md#a-404-before-recovery-admission).

## Pending create is admission

Create returns a durable pending receipt promptly; provider validation and
preparation run in the server worker. Keep its ID/key and poll detail/events until
ready or a terminal failure. Selection failures may arrive as failed preallocation
receipts rather than a synchronous create HTTP error. Replaying the same key and
payload discovers the same operation and never forks it again. Recovery also
supports a never-conversed registered pending first create; it is explicit abort,
not permission to resume initialization or adopt a newer generation.
