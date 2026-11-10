# Interrupted launch recovery

A registered `starting` row has an exact provider sandbox ID and a two-minute
activity lease, renewed while launch setup runs. `status` reports this persisted
state without trying to promote it or requiring a provider observation.

After a server crash, the existing lifecycle worker waits for that lease to
expire, then stops the registered machine and records a failed launch with a
closed diagnostic. Provider failures retain a cleanup request and are retried;
only a confirmed stop or definitive absence sets `stopped_at`. Recovery never
searches by name or allocates a replacement. Unregistered allocations are outside
this recovery path.

To retire the reported row after upgrading the server:

```sh
armada status 631e164a-77e2-47b9-b152-c6a5d7433c25
armada stop 631e164a-77e2-47b9-b152-c6a5d7433c25
```

Allow the old activity lease to expire first (normally at most two minutes after
the last heartbeat). The lifecycle worker also performs cleanup automatically.
Stop treats a provider's definitive not-found response for the registered ID as
already stopped. Transport failures never count as confirmation.

Root cause: the service store's update SQL in `data.ts` excludes rows with a live
`activity_until` or reconciliation lease. Status tried to change `starting` to
`ready` while registration still owned that lease, producing the generic
`DataError`. The server-only insert migration did not refuse this update. After
lease expiry the lifecycle worker observed readiness but had no interrupted
launch policy, so the row remained starting. No migration or fence bypass is
needed.

A lost launch HTTP response (including 502) now says the outcome is unknown and
asks the caller to run `armada list` before retrying.
