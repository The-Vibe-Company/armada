# Sandbox traces in Langfuse

Export is server-side, organization-scoped and off by default. Armada records export jobs in the same database transaction that settles a
turn. Delivery runs in a background worker and requires no Langfuse request
during event acknowledgement, launch, or usage accounting. No project key is delivered to a sandbox.

Create a Langfuse project in [Cloud](https://langfuse.com) (choose your region),
or follow the [self-hosting guide](https://langfuse.com/self-hosting). For a
self-hosted installation, expose HTTPS reachable from armada-server. Use its
origin as host (no path). The server uses the supported
[OTLP HTTP/JSON endpoint](https://langfuse.com/integrations/native/opentelemetry)
with `x-langfuse-ingestion-version: 4` and posts turn scores best-effort to
`/api/public/scores`; no legacy ingestion API or SDK is required.

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
known, turn status and a generic failure category, plus tool names, MCP servers,
durations, statuses and IDs. Full mode additionally exports prompt/message text
(capped at 64 KiB UTF-8 per field), tool inputs/results (capped at 32 KiB UTF-8
with `input_truncated`/`output_truncated` flags), and failure text, which can
contain customer data and secrets. Choose full only with the appropriate
customer authorization and Langfuse retention policy. Each turn records the mode
in force when it settled. Delivery uses the more restrictive of that mode and
the current one, so switching to full never exports content for a turn that
settled under metadata.

Raw unknown harness payloads are never exported. Every exported string,
including nested tool fields, object keys, tags, metadata and failure text,
passes through the server's credential redactor (GitHub, Armada gateway and
Skillpack tokens, bearer values, JWTs, API keys and connection-string passwords)
before export, because runtime histories are not redacted at storage. Redaction
is pattern-based; it does not know arbitrary customer secrets. A sandbox whose
template (Boat, Modal) or Docker launch binds application secrets, or that
carries `application_secret_tainted`, always exports in metadata mode marked
`content_withheld: application_secret_bindings`. In either mode such a turn also
withholds provider- and sandbox-controlled strings: the trace name is fixed to
`Armada sandbox`, spans use fixed names (`Armada turn`, `generation`, `tool`),
and model names, MCP servers, usage metadata, agent-reported outcomes/branches,
and turn-event PR scanning are omitted, leaving token counts, cost, and numeric
metrics. Subscription quotes remain estimates, not invoices; unavailable costs
are omitted.

## Trace hierarchy, linking, and scores

Each sandbox is one Langfuse session (`langfuse.session.id = sandboxId`). Each
completed turn has a stable `traceId` with trace attributes propagated onto
every span: `langfuse.trace.name` (e.g. `antigravity · owner/repo #123`, or
fixed `Armada sandbox` when withheld), `langfuse.session.id`, `langfuse.user.id`
(`owner_id`), `langfuse.release`, `langfuse.trace.tags` (OTLP `arrayValue`:
provider, harness, status, plus repo, `pr_linked`, template, golden, and models
when trusted, or `content_withheld`), and `langfuse.trace.metadata.*` (`org_id`,
`provider`, `harness`, `prompt_id`, `pr_url`, `pr_number`, `pr_repo`,
`pr_state`, `branch`, `head_sha`, `repo`, `template_name`, `golden_name`,
`requested_model`, `executed_models`, `reasoning_effort`, `external_ref`,
`status`, `tool_count`, `tool_error_count`, `duration_ms`, `ttft_ms`).

- **Root `agent` span**: turn timing, `langfuse.observation.level` (`ERROR` on failed turns, `WARNING` on interrupted turns or tool errors, `DEFAULT` otherwise), 64 KiB scrubbed input/output caps in full mode, and turn status metadata.
- **Child `generation` spans**: one child per distinct model row in turn usage (never comma-joined; literal `"default"` is filtered out), emitting all five non-null token dimensions (`input`, `output`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `reasoning`), `cost_details`, and `langfuse.observation.completion_start_time` (first assistant message timestamp for TTFT).
- **Child `tool` spans**: `mcp_server`, `duration_ms`, `level=ERROR` on error, and 32 KiB scrubbed caps on `input`/`output` with `input_truncated`/`output_truncated` flags.

PR, repository, branch, head SHA, template, golden, and `external_ref` linking
follows deterministic precedence: (1) `sandboxes.pull_requests`, (2)
`sandboxes.task_outcome` / `pull_request_reports` (trusted turns only), (3)
strict GitHub PR URL allowlist (`https://github.com/<owner>/<repo>/pull/<n>`)
over turn events only when content is not withheld. PR URLs are canonicalized
without query strings or fragments; repo/branch also falls back to
`pull_request_source`, `resource_project`, and `pull_request_scan`.

After OTLP `2xx`, Armada posts idempotent turn scores best-effort to
`${host}/api/public/scores` with `id = sha256("${traceId}:${name}").slice(0, 32)`:
`turn_success` (`BOOLEAN`), `tool_error_rate` (`NUMERIC`, when tools ran),
`ttft_ms` (`NUMERIC`, when timing is complete), and `pr_linked` (`BOOLEAN`).
Non-2xx score responses or transport errors never fail the trace export job.

## Placement coverage and delivery bounds

| Placement | Harnesses | Available evidence |
| --- | --- | --- |
| Boat runtime | Codex, Claude Code, OpenCode | Encrypted per-turn runtime journal, recorded usage/cost, and sandbox metadata. |
| Modal runtime | Codex, Claude Code, OpenCode, Antigravity | Encrypted per-turn runtime journal, recorded usage/cost, and sandbox metadata. |
| Docker host runtime | Codex, Claude Code, OpenCode, Antigravity | Encrypted per-turn runtime journal, recorded usage/cost, and sandbox metadata. |

When start timing is unavailable, Armada emits an instant observation marked
`timing_incomplete`. If the terminal event is missing, Armada uses the recorded
settlement status and observation time. Turns settled before export was enabled
are not backfilled.

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
can replay the same stable trace, observation, and score IDs. Disabling may leave an in-flight
request running. Settings are resolved when the job is claimed.

Deployment requires the Langfuse export migration, the normal encryption key,
and outbound HTTPS to the chosen Langfuse origin. Apply migrations through
the normal validated deployment path.
