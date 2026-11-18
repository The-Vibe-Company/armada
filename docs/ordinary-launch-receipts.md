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
again. Replay first repeats launch preflight (golden visibility, provider
configuration and the ability to pin an allocation authority), so a removed
golden returns `not_found` before the receipt is read. The golden id is part
of the request fingerprint, so a golden recreated under the same name returns
`conflict`. Neither error is the original outcome. An unfinished receipt
returns `outcome_unknown` and the stable UUID.
It does not claim that the machine is stopped or safe to recreate.

Use `launch_receipt` with `id` (the receipt UUID) and, when the caller belongs
to several organizations, `org` (the organization UUID). A replay that answers
`outcome_unknown` or `conflict` names the receipt UUID. Only the launching owner can read the receipt.
The lookup uses the provider binding stored on the receipt at admission
(provider target, backend identity and management identity), not the source
golden, and returns physical IDs even if sandbox registration never happened.
If the current provider configuration no longer matches that binding, the
outcome is `authority_blocked`. Empty results do not establish non-allocation (provider visibility
can lag). A server crash before receipt completion remains unknown even when
an Armada row exists: no agent effects are replayed automatically.

For an unregistered orphan, an authorized operator can retire the returned
physical ID using provider controls, after confirming the original call is no
longer active. Do not issue another launch with a new key to recover unknown
work. Registered machines retain the normal status/stop lifecycle. Deleting the
source golden does not block `launch_receipt`, but it makes a replay fail
preflight before the receipt is read, so a caller whose first reply was lost
never learns the receipt UUID. Without that UUID there is no self-service
lookup: keep the original key and escalate to an operator with the
organization, the key and the external reference.

The new migration must be deployed by the normal validated release path before
the server version. No provider calls are made by unit CI. Deployed fault
validation belongs in staging, not the PR gate.
