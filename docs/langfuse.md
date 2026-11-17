# Sandbox traces in Langfuse

Export is server-side, organization-scoped and off by default. It consumes only
newly committed runtime terminal events; it never gates event acknowledgement,
launch, or usage accounting. No project key is delivered to a sandbox.

Create a Langfuse project in [Cloud](https://langfuse.com) (choose your region),
or follow the [self-hosting guide](https://langfuse.com/self-hosting). For a
self-hosted installation, expose HTTPS reachable from armada-server. Use its
origin as host (no path). The server uses the supported
[OTLP HTTP/JSON endpoint](https://langfuse.com/integrations/native/opentelemetry),
with the v4 ingestion header; no legacy ingestion API or SDK is required.

An organization admin sends an authenticated `PUT` to
`/api/v1/orgs/<org-id>/langfuse` with JSON fields `enabled` (boolean), `host`
(HTTPS origin), `publicKey`, `secretKey`, and `contentMode` (`metadata` or `full`).
Send this body from a protected file or stdin, never keys in command arguments.
Both keys and host are encrypted together with ARMADA_ENCRYPTION_KEY. RLS and
explicit privilege revocation deny all user-JWT table access. GET returns only
enabled/content mode and process-wide export counters, never the host or keys.
DELETE removes configuration and disables future exports. PUT replaces the
complete configuration, so include keys again when changing the mode.

Metadata mode exports timing, model/token usage, persisted estimated cost when
known, turn status and a generic failure category, plus tool names/status and
IDs. Full mode additionally exports prompt/message text, tool inputs/results
and failure text, which can contain customer data and secrets. Choose full
only with the appropriate customer authorization and Langfuse retention policy.
Raw unknown harness payloads are never exported. Subscription quotes remain
estimates, not invoices; unavailable costs are omitted.

Each sandbox has a stable trace ID, each completed turn a stable observation
ID and each tool a child observation. Terminal failures are exported too.
A missing start event prevents export rather than inventing a duration.
Only runtime event ingest is covered; historical events and native paths that
do not use that endpoint are not backfilled.

The process holds at most 64 queued jobs and one active export. Each job reads
at most 2000 archive records / 4 MiB ciphertext; larger sandbox histories drop.
Requests time out after five seconds, reject redirects, and have no retries.
The GET counters `dropped`, `failed`, `exported` reset on server restart and are
process-wide. Overload, shutdown and outages can lose traces; this is best-effort
observability, not an audit archive. Disabling does not cancel an in-flight
request. Settings are resolved at drain time. Runtime replay ACKs do not enqueue
exports again. Start/end time reflects harness-reported timestamps.

Deployment requires the new org_langfuse migration, the normal encryption key,
and outbound HTTPS to the chosen Langfuse origin. Apply migrations only through
the normal validated deployment path.
