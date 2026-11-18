# Ordinary MCP launch receipts

For MCP `launch`, send a stable `idempotencyKey` (16–128
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

If replay returns an unknown outcome, look for registered sandboxes by
`externalRef`. Escalate unregistered allocations to an authorized operator
with the organization, original key, external reference and receipt UUID
when available. The provider's `sandbox` ownership label carries the receipt
UUID. Confirm the first call is no longer active before retiring a machine
through provider controls. Keep the original key through incident recovery.

Resolve outstanding versioned launch retries before deploying the tool removal.
Keys from the retired versioned sizing tool can conflict because their
fingerprints include the sizing version field. Treat that conflict as a
reference to the original receipt and follow the same recovery steps.

The new migration must be deployed by the normal validated release path before
the server version. No provider calls are made by unit CI. Deployed fault
validation belongs in staging, not the PR gate.
