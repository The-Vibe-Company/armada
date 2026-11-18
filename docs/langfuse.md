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
Initial configuration requires both keys. The defaults are
`https://cloud.langfuse.com`, `metadata`, and disabled. Subsequent updates
retain omitted fields, including when switching export off. A new host requires
both keys so saved credentials stay bound to their original origin.
Send the body from a protected file or stdin. Both keys and the host are encrypted
with ARMADA_ENCRYPTION_KEY. RLS and explicit privilege revocation deny all
user-JWT table access.

GET returns `enabled` and `contentMode` to organization members. For admins it
also returns `host`, `publicKey`, `configured` (whether credentials are stored),
durable organization counters, and `lastExportAt` (the last successful export
time, or null). The existing `content_mode` field remains available to admins
with saved settings. The secret key is write-only. DELETE removes configuration
and disables future exports.

An admin can POST to `/api/v1/orgs/<org-id>/langfuse/test` with candidate `host`,
`publicKey` or `secretKey` fields. Omitted fields use the saved values when
available, subject to the same rule for changing origins. The check reads
[Langfuse project access](https://langfuse.com/docs/api-and-data-platform/features/public-api)
over HTTPS without sending a trace or saving changes. It refuses redirects and
times out after five seconds. The response `status` is `ok` for success,
`rejected` for a 401 or 403, or `unreachable` for transport failures and other
unsuccessful responses. Outbound destination restrictions are tracked in #2587.

Metadata mode exports timing, model/token usage, persisted estimated cost when
known, turn status and a generic failure category, plus tool names/status and
IDs. Full mode additionally exports prompt/message text, tool inputs/results
and failure text, which can contain customer data and secrets. Choose full
only with the appropriate customer authorization and Langfuse retention policy.
Each turn records the mode in force when it settled. Delivery uses the more
restrictive of that mode and the current one, so switching to full never
exports content for a turn that settled under metadata.
Raw unknown harness payloads are never exported. Every exported string,
including nested tool fields, their object keys and failure text, passes through the server's
credential redactor (GitHub, Armada gateway and Skillpack tokens, bearer
values, JWTs, API keys and connection-string passwords) before it is sent,
because native provider histories are not redacted at storage. Redaction is
pattern-based; it does not know arbitrary customer secrets. A sandbox whose
template (Boat, Modal) or Docker launch binds application secrets, or that
carries the irreversible `application_secret_tainted` marker, has received raw values, which
no pattern matches and which the export cannot recover to mask exactly. Its
turns are therefore always exported in metadata mode, marked
`content_withheld: application_secret_bindings`, even when the organization
chose full mode. In either mode such a turn also carries no provider-controlled
string: tool observations are named `tool`, and the model name and per-turn
usage metadata are omitted, leaving token counts and cost. Subscription quotes remain
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
newest prompt event, relative to the run it knew before the steer. If no new
run is visible yet when steer returns, Armada keeps a durable steer cursor at
the last known run. The native receipt worker (about every ten seconds, for
one hour after the steer) registers every later run as a native receipt, so the
replacement settles and exports like any other turn. It reads retained provider
history under the owner and provider-binding fences, so this also works after the
sandbox stopped. Later runs are identified
by the provider's event order, not by timestamps, so a replacement whose prompt
event shares the previous run's timestamp is still found. A steer that follows an
unresolved steer keeps the older cursor. If the cursor run falls outside the
bounded event read, only the newest run is registered.

Pending export identities survive server restarts. A worker leases each job and
records the outcome and organization counters together. An unfinished lease
can be reclaimed after expiry; each claim reserves an attempt, and a job
abandoned five times by worker timeouts or shutdown settles as `failed`. Runtime history is read per turn, from the
turn's first archived event to its settlement, and is bounded at 2,000 records
and 4 MiB of ciphertext, and each outbound payload is bounded at 4 MiB.
Oversized exports and jobs whose settings were disabled before delivery count
as `dropped`. A native receipt that the provider fails to answer five times in
a row is abandoned before settlement, so its turn also counts as `dropped`. Transport, decryption and export-processing failures count as
`failed`. Requests time out after five seconds, reject redirects, and failed
requests are counted without an automatic retry. A restart during delivery
can replay the same stable observation ID. Disabling may leave an in-flight
request running. Settings are resolved when the job is claimed.

Deployment requires the Langfuse export migration, the normal encryption key,
and outbound HTTPS to the chosen Langfuse origin. Apply migrations through
the normal validated deployment path.
