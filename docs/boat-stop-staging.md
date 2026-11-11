# Boat stop regression check (#994)

Run against staging only with an authorized Armada session and a disposable Boat
sandbox; do not reuse a production sandbox. No migration is needed.

1. Launch from a staging Boat golden, then exercise `exec`, `send`, `wait` and
   `logs` as usual. Save the Armada sandbox ID.
2. Run `armada stop <id> --json`, then immediately repeat it. Both should return
   the same sandbox with `stopping` or `stopped`, not a lease conflict or a second
   physical stop request.
3. While archival is pending, run `armada status <id> --json` and
   `armada detail <id> --json`. Both should return the sandbox, not 409. A pending
   stop does not promise fresh prompt history from compute that is shutting down.
4. Poll those reads for a few lifecycle reconciliation cycles (one minute each).
   Once Boat confirms archival, status should become `stopped`, with `stoppedAt`
   populated in `armada list --json`. If Boat cannot confirm, the read remains
   available and `statusReason` reports the retry diagnostic rather than claiming
   success. Repeated reads/retries must not resume compute or delete retained data.
5. Repeat stop after completion: it should still return `stopped`. Inspect server
   diagnostics for one `sandbox_stop_dispatch` for this successful archival, not
   repeated dispatches while Boat reports `archiving`.

If Boat remains `archiving`, investigate its archival operation rather than
replaying stop against the shutting-down machine. Armada observes it and retains
its data; it does not infer physical exit from elapsed time.
