# Embed Armada

Use the Armada HTTP API from your application's backend. Launch a sandbox for
your product's work item, give authorized users a short-lived viewer token, and
use webhooks to learn when a turn settles or a file is available.

## Authenticate

Send `Authorization: Bearer <token>` on each authenticated request. The control
API accepts Armada service tokens, Armada OAuth access tokens and verified
Supabase sessions. For a backend integration, sign in with the CLI and create a
revocable service token scoped to the intended organization:

```sh
armada token create --org acme --label product-backend
```

Store the token in your backend's secret store when it is printed. Armada
stores its hash. Access still depends on the issuing user's membership and
permissions. Keep this bearer out of browsers, URLs and logs. Send
`Content-Type: application/json` with JSON request bodies.

## Launch a sandbox

`POST /api/v1/sandbox/launch` serves Boat, Modal and Docker, but Docker takes a
different body (see [Docker launches](#docker-launches)). For Boat and Modal,
the body requires `provider`, a snapshot name in `golden`, and an agent
identifier in `harness`. This example assumes a Modal snapshot called `review` and a
configured Codex account:

```json
{
  "golden": "review",
  "provider": "modal",
  "harness": "codex",
  "prompt": "Review the application and write a summary to /home/user/outputs/summary.md.",
  "idempotencyKey": "application-1042-launch-1",
  "externalRef": "application-1042"
}
```

Omit `prompt` to launch without starting a turn. The first
`sandbox/send` then opens the conversation. Save the returned Armada
sandbox ID from `sandbox.id` for subsequent calls. Ordinary cloud launches
inherit snapshot visibility. A private snapshot is visible to its owner.

- Put `idempotencyKey` in the JSON body (16–128 characters). The receipt is
  scoped to the caller and organization. Reusing the key with changed input
  returns HTTP 409 `conflict`.
- Set `externalRef` to an opaque product identifier (1–200 characters, no
  control characters). The reference can be shared by several sandboxes.
  It is returned by launch, authorized status and list reads, and webhooks.
- After a dropped response or HTTP 503 `outcome_unknown`, keep the original
  key and body. A replay returns the recorded result only if the request
  still passes launch preflight: the same snapshot must still be visible to
  the caller under the same name and provider, its provider account must still
  be configured, and the server must still be able to pin an allocation
  authority. Armada runs these checks before it reads the receipt. For example,
  if the snapshot was removed, the replay returns `not_found` without
  consulting the receipt. If it was recreated under the same name, the new
  snapshot ID changes the request and the replay returns 409 `conflict`.
  Neither error means the original launch failed.
- When a replay returns one of these errors, never launch with a new key. Look
  up recorded sandboxes with `POST /api/v1/sandbox/list` and
  `{"externalRef":"application-1042"}`. An empty list is expected when the
  allocation succeeded but the sandbox was never registered.
- If recovery needs an operator, include the organization, idempotency key,
  `externalRef` and receipt UUID when available. The UUID is the logical sandbox
  ID and is recorded in the provider's sandbox ownership label.

The recovery rules above describe Boat and Modal launches. See [idempotency and recovery](../launch-idempotency.md)
for receipt lookup and template launch keys.

### Docker launches

A launch with `"provider":"docker"` takes a host or Docker snapshot as its
source. Send one replay identifier, either an `idempotencyKey` or a caller-chosen
`requestId` UUID. The request UUID becomes the sandbox ID when supplied.
Replay the same inputs with the same identifier. A changed normalized request
returns 409 `conflict`. Set `externalRef` to look up the sandbox later.

- Select `org` by slug or UUID with a personal session. A scoped token can
  omit it or send its scoped UUID.
- `hostId` (a Docker host UUID) is required, unless you launch from a Docker
  snapshot with `snapshotId` (a snapshot UUID). The snapshot selects its host:
  a different `hostId` returns 404 `not_found`, and `repos` with
  `snapshotId` returns 400 `invalid`.
- `harness` is required. Optional fields include `credentialId`,
  `credentialVersion`, `model`, `reasoningEffort`, `prompt`, `ttlSeconds`,
  `repos`, `skills` and `"visibility":"private"`.

The launch call returns as soon as Armada admits the launch. A worker then
starts the sandbox on the host and sends the prompt. The first response
therefore normally carries `"status":"starting"` and no `promptId` or
`conversationId`. To follow the launch, call `sandbox/status` with the
returned sandbox ID. Replaying the same identifier and body starts at most one launch.

- The replay reports the sandbox's current status, not the status of an
  earlier response. Until the worker publishes the launch receipt, a sandbox
  that is `ready` or `running` is reported as `starting`. A sandbox that is
  stopped, failed or deleted keeps that status.
- The replay carries the recorded `promptId` and `conversationId` only once the
  worker has published the launch receipt and the launch sent a prompt. It
  never carries them before.

After a dropped response, poll `sandbox/status` with the `requestId` as `id`.
For a launch that sent a prompt, read the prompt receipt by replaying the same
request and checking the response for `promptId` and `conversationId`, not its
status. A `starting` response without
them means the launch is still pending, so replay again later. A `stopped`,
`failed` or `deleted` response without them is a separate outcome: no prompt
receipt will ever exist, but that does not prove the prompt never ran. The
sandbox may have ended while the launch was queued, before the prompt was sent.
It may also have ended after the worker sent the prompt but before it recorded
the receipt, so the agent may already have acted on it. Treat the prompt outcome
as uncertain: inspect the original sandbox with `sandbox/status` and its
transcript with `logs/read` before you repeat the work. Do not launch with a
new `requestId` until you know that the first launch failed or ended.
See
[Docker hosts](../docker-host-daemon.md) for an example body.

## Embed the conversation

Authorize the product user in your backend, then use the backend's Armada
service token to call `POST /api/v1/sandbox/viewer-token` with
`{"id":"<sandbox UUID>"}`. Return the resulting `{token, expiresAt}` to the
browser. The token expires after five minutes and is bound to one sandbox.
Renew it through the same backend authorization flow.

Minting needs only read access: the token's issuer must be able to read the
sandbox's logs, which requires the sandbox owner or an organization admin,
whatever the sandbox's visibility. Every viewer call then runs as that issuer.
`viewer/status`, `viewer/logs` and `viewer/events` work for either, but
`viewer/send` succeeds only when the issuing service token belongs to the
sandbox owner. Otherwise it returns HTTP 404 `not_found` ("No owned sandbox"),
even for an organization admin.
For an interactive embed, mint with a service token created by the sandbox
owner, and check that your product user may send prompts to this sandbox
before you hand over the token.

A viewer token has no read-only scope. It carries the full send authority of
its issuer, so a token minted with the owner's service token can always send,
even if your product only shows a read-only view. A backend that launches a
sandbox with its own service token owns that sandbox. If it reuses that token
to mint for a view-only user, that user can send prompts with
`viewer/send`. For a read-only embed, do one of the following:

- Mint with a service token created by an organization admin who does not
  own the sandbox. Minting requires the owner or an organization admin, even
  on an organization-visible sandbox, so an ordinary member's token cannot
  mint. Sends from the admin's token are always refused, usually with 404
  `not_found`. When an earlier send check fails first, the refusal is 409
  `credential_binding_required` or 409 `sandbox_terminal` instead (see the
  send checks below).
- Keep the bearer on your backend and expose only proxy routes for
  `viewer/status`, `viewer/logs` and `viewer/events`. Do not give the browser
  the viewer token or a route to `viewer/send`.

| Viewer route | Input |
| --- | --- |
| `POST /api/v1/viewer/status` | `{}` |
| `POST /api/v1/viewer/logs` | `{}` or `{"cursor":"<saved cursor>"}` |
| `POST /api/v1/viewer/send` | `{"message":"Write a shorter summary","requestId":"<UUID>"}` |
| `GET /api/v1/viewer/events` | Optional URL-encoded `cursor` query parameter |

Use `fetch` with the viewer bearer to read the server-sent event stream through
a same-origin proxy. Each `page` event contains a logs page. Save its JSON
`cursor` and reuse it on reconnect. Pages request at most 100 events and a
64 KiB provider byte budget. Existing events can be updated, so reconcile by
event ID. On `access-ended` or stream closure, reconnect or reauthorize as
appropriate. See [sandbox viewers](sandbox-viewer.md) for proxy and polling
details.

## Drive a turn over MCP

| Tool | Mode | Result |
| --- | --- | --- |
| `send` | `steer: true`, with the instruction in `prompt` | Redirect the running turn. The receipt includes `delivery` and `mode`. |
| `status` | `wait: true` | Wait for settlement and return status with `timedOut`. Omit `recorded` when waiting. |
| `stop` | `turn: true` | Interrupt the turn and keep the machine up. The receipt includes `interrupted`. |

The wait mode accepts `timeout_seconds` from 0 to 600 and defaults to 60.
Steer and interrupt target the sandbox by ID. The standalone steer, wait and
interrupt operations are available through the REST API.

## Drive the sandbox from your backend

These routes are POSTs under `/api/v1/`. The table shows JSON body fields.
`id` is the Armada sandbox UUID. Supply an `org` selector when needed for
organization routing. For service or Armada OAuth bearers, omit `org` or use
the UUID bound to the token.

Each request body is limited to 128 KiB (131,072 bytes) of serialized JSON,
counted before parsing. `logs/read` accepts up to 512 KiB. A larger body is
rejected before any sandbox check or queue admission with HTTP 413 and code
`invalid`, so nothing is sent. This includes a `sandbox/send` whose `prompt`
pushes the body over the limit. Shorten the prompt, or put large context in a
repository or file the agent can read, then send again. `viewer/send` reports
an oversized body differently: a viewer body over 128 KiB returns HTTP 503
`{"error":"viewer_access_denied"}`, which is not an outage, so do not retry it
unchanged. Armada adds the sandbox `id` and `request_id` when it forwards the
message, so a message just under the limit can still be refused with 413. Keep
viewer messages well below 128 KiB.

| Route | Required | Optional | Result |
| --- | --- | --- | --- |
| `sandbox/list` | None, send `{}` | `org`, `externalRef`, `harness`, `golden` (snapshot UUID), `owner` (UUID or `me`), `status` (nonempty array), `page`, `limit` | `sandboxes`, `total`, `page`, `limit`, `hasMore`, `nextPage`. Page starts at 1 and is capped at 1,000,000. Default limit 25, maximum 200. Deleted rows are excluded by default. |
| `sandbox/status` | `id` | `prompt_id`, `recorded` (boolean) | Sandbox status and turn details. Omit `prompt_id` for the latest turn. With `recorded: true` use stored state. |
| `sandbox/wait` | `id` | `prompt_id`, `timeout_seconds` (integer 0–600, default 60) | Status with `timedOut`. Call again to keep waiting. |
| `sandbox/send` | `id`, `prompt` | `request_id` (UUID), `model` and `reasoning_effort`, subject to the rules below | Includes `promptId`, `conversationId` and the send status, which can be `queued`. A queued answer also includes `requestId`. |
| `sandbox/stop` | `id` | `request_id` (UUID), `only_if_idle` (boolean) | `id`, `status` and an optional `preservationNote`. |

Send rules depend on the sandbox:

| Sandbox | `request_id` | `model`, `reasoning_effort` |
| --- | --- | --- |
| Native Boat or Modal | Optional | Optional, for this turn only |
| Runtime Boat or Modal, including OpenCode | Required without a pinned model account. Otherwise Armada generates one when omitted. | Refused. Boat accepts values equal to the launch values. |
| Docker | Armada generates one when omitted, because every Docker sandbox has a pinned model account | Refused |

Before the queue or the provider sees a send, Armada checks the sandbox, in
this order:

1. HTTP 404 `not_found` when the caller is neither the sandbox owner nor an
   admin of its organization.
2. HTTP 409 `credential_binding_required` for a Modal sandbox without a model
   account binding that could otherwise accept the send, including a stopped
   and retained one. A `request_id` does not bypass this check. The sandbox
   owner must bind an account first, on the sandbox's dashboard page, with
   `armada bind-credential`, or with `POST /api/v1/sandbox/bind-credential`
   and `{"id":"<sandbox UUID>","credentialId":"<account UUID>"}`. The
   workspace and conversations are retained.
3. HTTP 409 `sandbox_terminal` when the sandbox cannot take a send in its
   current state: it has expired, failed or been deleted, or it is stopped and
   a send cannot resume it. Stopped Boat and Modal sandboxes resume on send
   when their work was retained, and idle-paused sandboxes wake on send. A
   Docker sandbox stopped any other way refuses sends. Its owner can try
   `POST /api/v1/sandbox/resume` with `id` and a `request_id` UUID, which
   restarts the same allocation when it is still retained.
4. HTTP 404 `not_found` ("No owned sandbox") when the caller does not own the
   sandbox. Read access is not enough: an organization admin who passes the
   first check still gets 404 here. Because this check comes last, the same
   admin gets 409 `credential_binding_required` or 409 `sandbox_terminal`
   instead when check 2 or 3 fails first.
   Send with a service token created by the sandbox owner.

Send opens or continues the sandbox's conversation. Send and runtime resume
refuse conversation selectors with HTTP 409 `conflict`. Launch another sandbox
for a separate conversation. An identical retry of an admitted account-queued
send can still retrieve its original receipt. For a send originally submitted
with a selector, use `sandbox/status` with its original request UUID as
`prompt_id` to reconcile the outcome.

Sends that pass these checks to a sandbox with a pinned model account, which
includes every Docker sandbox, then pass through the account turn queue. For runtime and Docker
sandboxes, the queue returns HTTP 400 `invalid` for a refused override. It
returns HTTP 409
`conflict` when the sandbox cannot accept a prompt now, for example while a
Docker launch is still `starting`. It also returns 409 `conflict` for a reused
`request_id` with different input, or for one whose queued send has failed.

An admitted send returns `queued` with its `requestId`. Until the conversation
is recorded, the returned `conversationId` is a placeholder. Armada dispatches
the prompt after earlier prompts for the sandbox finish. Docker applies its
own checks at dispatch, and a prompt rejected there is marked failed. Call
`sandbox/status` with the `requestId` as `prompt_id` to follow a queued send.
Until dispatch, status reports the turn as `running`, with the queue message
in `statusMessage`. A rejected send reports `failed` with the reason.

A Boat runtime sandbox without a pinned model account accepts a send only
while it is stopped and resumable. Otherwise the send returns 409 `conflict`.
A Modal sandbox in that state returns `credential_binding_required` first. Such a
send returns HTTP 400 `invalid` for a refused override or a missing UUID
`request_id`. Runtime and Docker
sends keep the model and reasoning effort selected at launch. When Armada
generates the request ID, it returns it as `requestId`. If that answer is lost,
the send cannot be replayed, so send your own.

Supply a stable request UUID for sends, as `request_id` on backend requests
and `requestId` on viewer requests. The account turn queue deduplicates by
request ID for sends it admits, including native sends with a pinned model
account. Direct runtime sends use the request ID for replay with identical
input. Direct native dispatch has no request-ID deduplication. Inspect
status before retrying an uncertain send.

The sandbox states are `starting`, `ready`, `running`, `stopping`, `stopped`,
`failed` and `deleted`. A turn has its own state. Send can return `queued`
before a turn starts, and status can report a turn as `running`, `finished`,
`interrupted` or `failed`. A `stopping` response is an acknowledgment of
the lifecycle transition. Check status for completion. Resuming a stopped
sandbox depends on retaining recoverable work. See the
[lifecycle state model](../state-model.md).

## Receive signed webhooks

An organization admin registers a public HTTPS receiver with
`POST /api/v1/webhooks?org=<org UUID>` and
`{"url":"https://receiver.example/events"}`. Save the `secret` from the 201 response.
The event types are:

- `turn.finished`, `turn.failed`
- `sandbox.stopped`, `sandbox.expired`, `sandbox.reclaimed`
- `agent.report.ready`, `agent.report.blocked`
- `sandbox.output.available`

Verify `Armada-Webhook-Signature` (`v1=<hex HMAC-SHA256>`) with the endpoint
secret over the exact bytes of
`Armada-Webhook-Timestamp + "." + Armada-Webhook-Id + "." + rawBody`.
Check timestamp freshness and deduplicate by the stable delivery ID before
producing side effects. Return 2xx after durable acceptance. Deliveries carry
`externalRef` (null if absent) and may be retried, with up to five attempts.
See [outbound webhooks](../outbound-webhooks.md) for payloads and endpoint management.

## Download outputs

Have the agent write files directly to `/home/user/outputs` on every provider.
Authorized owners and organization admins can list metadata with
`GET /api/v1/sandboxes/{id}/outputs` and download bytes with
`GET /api/v1/sandboxes/{id}/outputs/{encodedName}`.

Only regular files directly in that directory are collected. The snapshot is
limited to 32 files, 32 KiB per file and 32 KiB total. A directory with more than
4,096 entries is skipped. Armada samples while compute is live and serves the
last successful capture after stop. A provider-initiated stop can leave writes
since the last capture unavailable. Sandboxes exposed to application secrets
return 404 for outputs. The `sandbox.output.available` event includes file
metadata, so fetch the bytes separately. See [sandbox outputs](../sandbox-outputs.md)
for sampling, exclusions and stop-time limits.

## Handle errors

Ordinary control errors use `{"error":{"code":"…","message":"…"}}`. Branch on the
code. Handle 400 `invalid` for request correction, 413 `invalid` for a request
body over the size limit, 401 `unauthorized` for
authentication, 403 `forbidden` for permission, and 404 `not_found` for a
missing or inaccessible sandbox. A 409 `conflict` or `sandbox_not_ready`
requires checking the current state or request before retrying. A 409
`sandbox_terminal` means the sandbox cannot take that control in its current
state, and the message says why. An expired, failed or deleted sandbox is
final. A stopped Boat or Modal sandbox with retained work resumes on a send,
after which steer, exec and interrupt work again. A stopped Docker sandbox
needs `sandbox/resume` first. A 409 `credential_binding_required` means the sandbox owner must
bind a model account before a control can succeed. Docker launches report
request errors as 400 `invalid_request`. A 503
`outcome_unknown` requires inspecting or replaying the existing operation
with the same identity.

Viewer grant errors use `{"error":"viewer_access_denied"}`. Forwarded viewer
calls can return ordinary control errors. Webhooks management and output routes
also use string-valued `error` bodies. See the [error-code catalogue](../api-error-codes.md)
for control mappings by route.
