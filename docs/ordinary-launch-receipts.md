# Ordinary MCP launch receipts

For `launch` and `launch_sized_v1`, send a stable `idempotencyKey` (16–128
characters) and reuse the identical request on transport retries. Keys are
scoped to the launching owner and organization. Omitting a key creates a
server-generated receipt but cannot correlate a retry after a lost reply.
A changed payload with the same key is refused. Receipts are never expired or
released for redispatch, including failed validation or uncertain persistence.

The server commits the logical sandbox UUID before dispatch. This same UUID
is sent in the provider's `sandbox` ownership label. A completed response is
persisted before replying; replay returns it without initializing or prompting
again. An unfinished receipt returns `outcome_unknown` and the stable UUID.
It does not claim that the machine is stopped or safe to recreate.

Use `launch_receipt` with the receipt UUID and source golden/org/provider to
inspect. This performs an owner/org-authorized label lookup through the
provider adapter and returns physical IDs, even if sandbox registration never
happened. Empty results do not establish non-allocation (provider visibility
can lag). A server crash before receipt completion remains unknown even when
an Armada row exists: no agent effects are replayed automatically.

For an unregistered orphan, an authorized operator can retire the returned
physical ID using provider controls, after confirming the original call is no
longer active. Do not issue another launch with a new key to recover unknown
work. Registered machines retain the normal status/stop lifecycle. Recovery
requires access to the original golden/provider binding; deleting that golden
before recovery requires operator intervention.

The new migration must be deployed by the normal validated release path before
the server version. No provider calls are made by unit CI. Deployed fault
validation belongs in staging, not the PR gate.
