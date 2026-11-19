# Inbound trigger design

The owner approved the inbound trigger surface on 2026-11-18, subject to encrypted signing secrets or hashed bearer tokens, a timestamp and replay window, per-trigger rate and concurrency limits, a bounded body, one fixed template and account pool, and treatment of the payload as untrusted prompt text. This design uses HMAC with an encrypted signing secret. It specifies the contract for #2822, #2823 and #2824, using the shared jobs runner from #2754.

## Request and authentication

- A trigger belongs to one organization and binds to one template and one account pool in that organization. Record the configuring org admin as the launch owner. Treat each launch as a delegation limited to these bindings. At admission require that owner to remain an org admin with current access to every resolved template resource and to the pool. Revocation fails closed. To change the owner or bindings, create a new trigger. The request can supply only the event body and authentication metadata. Resolve the template through normal launch admission and freeze its manifest when admitting the launch. Validate the bound resources at configuration and launch time. An unavailable binding or an exhausted pool fails closed. Apply normal pool health, credential scoping and spend rules.
- `POST /api/v1/hooks/{id}` accepts a UTF-8 body up to 256 KiB. Count bytes as they arrive, including for chunked requests, and stop at the limit before decoding, parsing or writing the body. Reject non-identity content encodings. The payload is opaque text.
- Require one each of `X-Armada-Timestamp` (canonical Unix seconds), `X-Armada-Delivery-Id` (1–128 ASCII letters, digits, underscores or hyphens), and `X-Armada-Signature` (64 lowercase hex digits). Reject duplicate or malformed headers. HMAC-SHA256 covers a UTF-8 prefix of method, canonical trigger path, timestamp and delivery ID, each followed by a newline, then the exact body bytes. Compare decoded digests in constant time. Accept timestamps within five minutes either side of server time and recheck freshness when committing admission.
- Generate a random 32-byte signing key, return it once to the creating or rotating org admin, and store it as `secret_enc` via `encryptSecret`. User JWTs cannot read the ciphertext. Keep keys, signatures and payloads out of logs. Rotation invalidates the previous key immediately. Check the verified key revision under the trigger row lock before committing admission so an in-flight check cannot race rotation.

## Admission and launch

After authentication, claim the delivery ID within the trigger's namespace. In one transaction, lock the trigger, recheck its enabled state and revision, dedupe the delivery, enforce the admission budget and commit the delivery and one shared-runner job keyed by the trigger and delivery IDs with a finite dispatch deadline. A duplicate of an accepted delivery returns 200 with its receipt and never makes a second job. Rate refusals create no delivery or job row and use bounded counters for audit. The sender can retry the same delivery ID after the indicated delay, signing again with a fresh timestamp if necessary. Keep accepted delivery receipts independently of payload retention and for as long as their jobs or launches can reconcile, with a minimum dedupe period of ten minutes plus clock tolerance after receipt. This covers the full validity of a timestamp first seen at the future edge of the window. Publish the minimum retry-dedupe period, and require senders to use a new delivery ID for each new event. Prune terminal receipts in coordination with their job idempotency records so admission cannot mistake a retained job for a fresh enqueue. Publish the existing runner wake only after commit. Return 202 with a receipt for newly queued work. Use 401 for invalid credentials, stale timestamps, and unknown or disabled triggers, 413 for oversize bodies, and 429 with a retry hint for rate refusal.

Use a durable per-trigger rate limit over a rolling window, charging each newly queued delivery once. The worker verifies the admission record and current policy. A claim in reconciliation-only mode may recover an existing intent or record a terminal refusal. It cannot create a reservation or launch intent. Serialize the worker's concurrency check and reservation per trigger. Count reserved launches and all nonterminal sandboxes attributed to the trigger, including work still provisioning or with unknown outcome. A cap refusal records a terminal outcome without creating a launch. Create or attach the reservation and normal launch intent under one transaction with the recorded launch owner, a stable delivery-derived idempotency key and a digest of the frozen launch request. A retry reads the recorded intent first and reuses it rather than resolving a new manifest. Release the reservation only when admission definitively failed before creating a sandbox, or normal lifecycle reconciliation confirms a terminal sandbox. Rate and concurrency limits apply across replicas and key rotations.

Disable blocks new deliveries and prevents queued jobs from creating launch intent. Serialize that check with reservation and launch intent creation. A launch already admitted continues through the normal lifecycle. Rotation changes request authentication and preserves prior accepted deliveries. The trigger job rechecks the stored binding and the current resource authorization before admitting work.

Insert the opaque body into the initial prompt as a clearly labeled, untrusted event field, using JSON string encoding so embedded delimiters stay inside the field. The trusted template defines the task and available tools. Never interpolate the body into commands, tool definitions, repository selection, model selection, credentials or other launch settings. Prompt framing is advisory. Use least-privilege credentials and a template with tools and destinations restricted to its approved task. Require independent authorization for privileged side effects.

## Durable states and recovery

| From | To | Writer | Condition |
| --- | --- | --- | --- |
| No delivery | Queued | HTTP admission transaction | Authenticated fresh delivery within rate limit, deduped under lock |
| Queued | Claimed | Shared jobs runner | Lease acquired or expired lease reclaimed |
| Claimed | Refused | Trigger handler via fenced completion | Disabled, invalid binding, expired dispatch budget or unavailable capacity |
| Claimed | Launch admitted | Trigger handler via fenced transaction | Policy passes, reservation and launch intent commit together |
| Launch admitted | Terminal outcome | Normal launch lifecycle and delivery projection | Definitive outcome from the durable launch record |

- Before admission commit, a crash rolls back the receipt and job together. After commit, a lost wake is recovered by the existing runner scan and a lost HTTP response by retrying the same delivery ID.
- After claim or renewal, loss of the worker leaves the runner to reclaim after expiry. Fence handler writes by lease epoch. After a refusal or launch-admission commit, the successor reads the receipt and any launch intent before completing. It never generates a fresh launch key. Use the existing launch job for provider dispatch and recovery. After an ambiguous outcome, keep the reservation until the lifecycle resolves it.
- Only the shared runner owns the trigger job lease. The normal launch worker owns the sandbox lease and deadline and fences provider work by sandbox ID and generation. HTTP admission, admin actions and provider adapters acquire neither lease.

| Provider | Runtime launch path | Provider-run path |
| --- | --- | --- |
| Boat | Normal launch job after runtime cutover | Outside this design |
| Modal | Normal launch job after runtime cutover | Outside this design |
| Docker | Normal launch job through the outbound daemon | No legacy trigger path |

## Administration and boundaries

Org admins create, rotate and disable triggers through the dashboard and API. Record configuration changes with actor, trigger, timestamp and action. Record delivery receipts, refusal or launch outcome, and sandbox reference when available. Keep payloads out of audit records and admin delivery lists. Use the jobs store's encrypted payload and server-only access. Clear the queued payload once it is no longer needed to dispatch or reconcile. Bound audit and dedupe retention separately.

This ticket delivers the design only. Endpoint, schema, worker and UI implementation are tracked separately. Sending to existing sandboxes, captain wait rows, provider-run launches, and provider-specific webhook adapters are out of scope.

## HTTP delivery contract

Use the lowercase UUID from the trigger URL and sign the canonical path with the raw 32-byte key. The server stores the key's base64 representation inside the encrypted envelope. Submit a new delivery ID for every event. Retry a delivery using the same ID, signing again with a fresh timestamp if needed. Accepted deliveries are deduplicated for at least 11 minutes and for as long as their jobs or launches can reconcile.

A new delivery returns HTTP 202 with `{triggerId, deliveryId, jobId}`. A repeat of an accepted delivery returns the same receipt with HTTP 200. HTTP 429 supplies the number of seconds to wait in the `Retry-After` header and the `retryAfter` response field. A non-identity content encoding returns HTTP 415. An authenticated body with invalid UTF-8 returns HTTP 400.

The rate budget counts committed deliveries in the preceding minute. The trigger's pool is the launch owner's pool for the bound harness. A newly queued job has a five-minute dispatch budget. Trigger setup and rotation must update the encrypted key and increment the key revision together.

## Inspection API

Organization admins can use their Armada API bearer to inspect inbound triggers.
Pass `org` as the organization UUID on both requests.

- `GET /api/v1/triggers?org=<org UUID>` returns `triggers` with each trigger's
  `id`, `templateId`, `poolHarness`, `enabled`, `ratePerMinute`, `concurrency`,
  and cumulative `rateRefusals`. A private template identifier is visible only to
  the template owner.
- `GET /api/v1/triggers/<trigger UUID>/deliveries?org=<org UUID>` returns the
  latest 100 admitted `deliveries`, newest first, with `deliveryId`,
  `receivedAt` and `jobState` (`queued`, `leased`, `done` or `failed`).
  This is the shared runner's processing state. Launch outcomes are tracked in #2823.

## Rotation and disable API

Use the same organization scope and admin authentication as the inspection API.

- `POST /api/v1/triggers/<trigger UUID>/rotate?org=<org UUID>` replaces the key
  of an enabled trigger and returns HTTP 200 with `{signingSecret}`. The
  response is non-cacheable. Decode the base64 value to obtain the 32-byte HMAC
  key. If the response is lost, rotate again to obtain a new key.
- `POST /api/v1/triggers/<trigger UUID>/disable?org=<org UUID>` disables
  admission and returns HTTP 204, including when the trigger is already
  disabled.

Each state change records the organization, actor, trigger, action and time in
the server-only audit table. Inspection responses continue to omit keys.
