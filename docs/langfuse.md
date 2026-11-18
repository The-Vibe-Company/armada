# Sandbox traces in Langfuse

Export is server-side, organization-scoped and off by default. Armada records export jobs in the same database transaction that settles a
turn. Delivery runs in a background worker and requires no Langfuse request
during event acknowledgement, launch, or usage accounting. No project key is delivered to a sandbox.

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
enabled/content mode, durable organization counters, and `lastExportAt` (the
last successful export time, or null). It omits the host and keys.
DELETE removes configuration and disables future exports. PUT replaces the
complete configuration, so include keys again when changing the mode.

Metadata mode exports timing, model/token usage, persisted estimated cost when
known, turn status and a generic failure category, plus tool names/status and
IDs. Full mode additionally exports prompt/message text, tool inputs/results
and failure text, which can contain customer data and secrets. Choose full
only with the appropriate customer authorization and Langfuse retention policy.
Raw unknown harness payloads are never exported. Every exported string,
including nested tool fields, their object keys and failure text, passes through the server's
credential redactor (GitHub, Armada gateway and Skillpack tokens, bearer
values, JWTs, API keys and connection-string passwords) before it is sent,
because native provider histories are not redacted at storage. Redaction is
pattern-based; it does not know arbitrary customer secrets. Subscription quotes remain
estimates, not invoices; unavailable costs are omitted.

Each sandbox has a stable trace ID, each completed turn a stable observation
ID and each tool a child observation. Terminal failures are exported too.
Coverage and available content vary by placement and harness.

| Placement and path | Harnesses | Available evidence |
| --- | --- | --- |
| Boat native | Codex, Claude Code | Normalized Boat prompt, response, model, and tool fields when the provider supplies them. Boat rewrites prompt status in place, so the original start can be absent. |
| Modal native | Codex, Claude Code | Stored normalized prompt and response events, tool fields emitted by the harness, and recorded usage and cost when available. |
| Boat and Modal runtime | Codex, Claude Code, OpenCode | Encrypted runtime journal with prompt and response events, harness-emitted tool fields, and recorded usage and cost when available. |
| Docker host runtime | Codex, Claude Code, OpenCode | The same runtime journal and usage projection as Boat and Modal runtime. |

OpenCode uses the shared runtime. An export includes only the fields found in
the applicable history. When start timing is unavailable, Armada emits an
instant observation marked `timing_incomplete`. If the terminal event is
missing, Armada uses the recorded settlement status and observation time.
Boat native uses the settlement observation time because a rewritten prompt
can still carry its original timestamp. Native Modal waits up to a minute
for its terminal journal event before exporting the evidence available. If a
native history read keeps failing for that minute, or does not answer within
ten seconds, Armada exports the recorded
status and observation time without transcript content, marked
`history_unavailable`. The ten-second deadline covers provider resolution
too; a read that outlives it is abandoned, and at most one such read per
turn and four in total stay outstanding before Armada stops starting new ones.
Turns settled before export was enabled are not backfilled.

A native steer is exported as the run it leaves in progress: the joined turn
(Claude Code) or the replacement run of a restart (Codex). When Boat answers
with a steer record instead of a run ID, Armada resolves the run from the
newest prompt event. If no new run is visible yet when steer returns, that
replacement is not exported; the interrupted run still is.

Pending export identities survive server restarts. A worker leases each job and
records the outcome and organization counters together. An unfinished lease
can be reclaimed after expiry; each claim reserves an attempt, and a job
abandoned five times by worker timeouts or shutdown settles as `failed`. Runtime history is read per turn, from the
turn's first archived event to its settlement, and is bounded at 2,000 records
and 4 MiB of ciphertext, and each outbound payload is bounded at 4 MiB.
Oversized exports and jobs whose settings were disabled before delivery count
as `dropped`. Transport, decryption and export-processing failures count as
`failed`. Requests time out after five seconds, reject redirects, and failed
requests are counted without an automatic retry. A restart during delivery
can replay the same stable observation ID. Disabling may leave an in-flight
request running. Settings are resolved when the job is claimed.

Deployment requires the Langfuse export migration, the normal encryption key,
and outbound HTTPS to the chosen Langfuse origin. Apply migrations through
the normal validated deployment path.
