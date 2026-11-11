# Preservation and stop order

- User stop holds a sandbox activity lease while it observes compute, quiesces
  turns, captures recovery and stores the result, before dispatching physical
  stop. A `stopping` database row is not a provider stop RPC. The lifecycle
  worker cannot claim a live activity lease.
- The lifecycle worker independently verifies turn settlement before capture.
  Managed-child stop also honors a pending preservation disposition. Pending
  interruption defers physical stop; deadlines cancel later exec admission.
- Boat quiescence skips interruption when no conversation is running. Otherwise
  it sends `/interrupt` and checks settlement, not `/stop` or `/resume`.
- Ordinary Boat stop runs its `beforeStop` hook, then sends `/stop`. Managed
  archival sends `/stop` through the archive helper.
- A clean capture clears the current preservation note; historical recovery
  archives remain retrievable. Failure notes require confirmed unpublished or
  dirty work (or a completed archive whose retrieval/storage failed). Failed
  inspection alone is **unknown**, not evidence of work at risk: it keeps a
  lower-severity “could not check” notice with a closed stage/reason and conditional
  resume/push advice. Unknown must never silently look like a successful clean check.
- Owner failure notes use a short closed stage/reason and an action. Detailed
  provider status, state admission and caller-order evidence remain in logs.

The [Boat lifecycle contract](https://docs.boat.dev/api/v1#sandbox-lifecycle)
says `ready` and `idle` accept commands; `idle` is not documented as suspended
compute. Do not introduce automatic wake or new state mappings without evidence.
