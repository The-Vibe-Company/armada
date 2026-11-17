# Outbound sandbox webhooks

Organization admins can register an HTTPS receiver through the authenticated API.
The legacy `notify_subscriptions` table had no sender; organization endpoints now
use a durable transactional outbox and a bounded background delivery worker.

All management requests require the `org` query parameter (organization UUID):

- `POST /api/v1/webhooks?org=<id>` with JSON `{ "url": "https://receiver.example/events" }`
  creates an endpoint and returns its signing secret **once**. Store it securely.
- `GET /api/v1/webhooks?org=<id>` lists endpoint metadata without signing secrets.
- `DELETE /api/v1/webhooks/<endpoint-id>?org=<id>` disables the endpoint.
- `GET /api/v1/webhooks/deliveries?org=<id>` lists recent deliveries; optional
  `endpointId` restricts the log to one endpoint. Only admins can access these logs.

Secrets use Armada's existing AES-256-GCM encryption under
`ARMADA_ENCRYPTION_KEY`. User JWTs cannot read endpoint ciphertext or the outbox
through direct database access.

Events are `turn.finished`, `turn.failed`, `sandbox.stopped`, `sandbox.expired`,
`sandbox.reclaimed`, `agent.report.ready`, and `agent.report.blocked`. Payloads
contain delivery/event identity, organization/sandbox/prompt IDs, state, occurrence
time, a public reason code, links, and **always** `externalRef` (null when absent).
There is no message, prompt, agent report text, or provider diagnostic by default.
Repeated terminal observations of one prompt are deduplicated durably per endpoint
and event type. Runtime archive ingestion enqueues terminal prompts atomically;
native prompt publication retains a durable receipt identity ledger. A bounded
observer reads those receipts even after stop or replacement of the current turn,
and uses the same admission function. It retains the persisted owner and provider
binding checks; it never resumes or mutates a stopped machine. Startup failures
without an admitted prompt do not manufacture turn events.
Queued sends use the same public prompt/request ID as the send/status API.
The provider-to-public mapping is captured with prompt publication and frozen in
the event payload, including when a fast terminal event precedes send-result storage.
Failure reasons use the public code `turn_failed` (or `interrupted` for an interrupted turn); a blocked report uses
`agent_blocked`. Fetch authorized sandbox details for further diagnostics.
The external reference follows the launch contract in
[launch idempotency](launch-idempotency.md) and PR #2574; it is an opaque correlation
value rather than an idempotency key.

Delivery requests use these headers:

- `Armada-Webhook-Id`: stable delivery UUID, unchanged across retries.
- `Armada-Webhook-Timestamp`: Unix seconds for this attempt.
- `Armada-Webhook-Signature`: `v1=<hex HMAC-SHA256>`.

Verify HMAC with the endpoint secret over the exact bytes
`timestamp + "." + deliveryId + "." + rawBody`, compare in constant time, and
reject timestamps outside a short tolerance (for example five minutes). Verify
before parsing or processing. Persist the delivery ID atomically with your side
effects: delivery is at least once, including when a receiver accepts an attempt
but the sender cannot record its response. A replayed ID must return success
without repeating side effects. Respond with 2xx after durable acceptance.

The sender makes at most five attempts with exponential backoff starting at
30 seconds and capped at one hour. A request has a bounded timeout; redirects
are not followed. The log records attempt count, last HTTP status and whether
successful. Response bodies are not retained. Disabling an endpoint stops further
delivery. A worker lease allows restart recovery without holding a database
transaction across a network request.

Deployment requires the additive `20261117210000_outbound_webhooks.sql` migration
and the existing encryption key. This document describes the contract, not
provider or deployed acceptance evidence. No new CI job is required.
