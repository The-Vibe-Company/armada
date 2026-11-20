# Snapshot scan provider contract follow-up

Boat SDK 1.13.0's CommandRequest documents an integer timeout from 1 through
600 seconds. Its generated serializer does not validate this constraint.
The public OpenAPI agrees:
https://docs.boat.dev/api/reference/agent/execute-sandbox-command

The scan requested 900 seconds. This violates the request contract before
execution; the scan now requests the maximum accepted 600 seconds. The scan
script, filesystem roots, binary matching and git-object coverage are unchanged.
Timeouts still fail closed and cannot produce a snapshot.

## Historical CLI transport incident

At the time of the incident, the synchronous CLI snapshot create and update
requests used a 600-second AbortSignal. The dashboard proxy used a 660-second
AbortSignal and declared maxDuration=800. The client disconnected after 270246 ms.
The investigation did not identify which runtime, gateway or connection imposed
that deadline.

The investigation tested disabling Bun's independent fetch idle timer with
`timeout: false` while preserving the explicit AbortSignal. The result did not
establish the cause of the production disconnect. The investigation ran no
production rebuild.

## Recovering a build receipt today

For Boat and Modal, `armada snapshot create` and `armada snapshot update` now
submit a durable build job and use short status requests. If the CLI disconnects or its local wait
ends, inspect the existing job before retrying. With the printed build ID:

```sh
armada snapshot build-status JOB_UUID
```

If the receipt was lost, look it up with the saved admission key and organization:

```sh
armada snapshot build-status --idempotency-key SAVED_KEY --org ORG_UUID
```

Replace `JOB_UUID`, `SAVED_KEY`, and `ORG_UUID` with the values from your
submission. See [durable snapshot build jobs](golden-build-jobs.md) for status
and recovery limits.
