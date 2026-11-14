# Routine scheduler effect ownership

Each scheduler instance reserves independent admission, recovery and observation
slots for Boat, Modal, Docker and an unknown-definition lane: at most twelve
tracked raw effects (one per operation/provider pair). Admission selects oldest
due occurrences within each provider; recovery selects least recently leased expired work;
observation selects least recently checked tasks. Recovery cannot consume fresh
admission capacity and observation cannot consume either dispatch capacity.
A stalled provider cannot consume another provider's reserved capacity.
Within a saturated provider lane progress waits for the owning raw effect.

Ticks await database admission, not provider effects. A sixty-second deadline
requests cooperative cancellation but does **not** release a slot. In-process
recovery excludes still-owned dispatch IDs even after lease expiry. Across
replicas, durable template claims and the lease identity check immediately before
allocation remain the allocation fences. An aborted dispatch without a claim
remains uncertain rather than becoming permission for another allocation.
Observation cancellation suppresses late publication; task_check_id still fences
publication across replicas. Provider prompt/event reads receive cancellation
where their interfaces support it; legacy launch effects may not cancel after
allocation and remain tracked until their full template call settles.

The worker owns all effects: stop closes admission and aborts effect signals;
worker.done drains raw effects. It deliberately does not claim successful shutdown
while an uncooperative provider promise is live. The enclosing process supervisor
owns the final shutdown grace period and termination. Durable leases/claims, not
an in-memory timeout, own recovery after process termination.

No provider outage was reproduced locally. Coordinator staging verification:
stall a Modal authority's launch and observation, check admission remains responsive
and Docker's reserved lanes progress; stop the worker and confirm cancellation,
draining and durable recovery without a duplicate allocation. Boat is not part of
the release gate.
