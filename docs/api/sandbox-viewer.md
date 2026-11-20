# Embed a sandbox session

Your backend calls `POST /api/v1/sandbox/viewer-token` with its Armada service
bearer and JSON `{ "id": "<sandbox UUID>" }`. It must authorize its own product
user before minting. Minting needs only read access to the sandbox's
logs (the sandbox owner or an organization admin), but
sending needs ownership (see `viewer/send` below). For an interactive embed,
mint with a service token created by the sandbox owner, and check that your
product user may send prompts to this sandbox before you hand over the token.
The viewer token has no read-only scope: a token minted with the owner's
service token can send, even in a view-only product screen. For a read-only
embed, mint with a service token created by an organization admin who does
not own the sandbox (an ordinary member cannot mint, even for an
organization-visible sandbox, because minting requires the owner or an
organization admin), or keep the viewer token on your backend and proxy
only `viewer/status`, `viewer/logs` and the sandbox event stream.
The response is `{ token, expiresAt }`. When the browser holds a
token, forward only this opaque token. It expires after five minutes; renew through your
backend. Never send the service bearer to the browser or put tokens in URLs.

The viewer bearer works only on these routes:

- `POST /api/v1/viewer/logs`: `{ "cursor": "<optional opaque cursor>" }`.
- `POST /api/v1/viewer/status`: `{}`.
- `POST /api/v1/viewer/send`: `{ "message": "...", "requestId": "<UUID>" }`.
  Supply a stable requestId when retrying runtime sends. Ordinary send admission
  still applies (busy turns may refuse a new message). Send runs as the issuing
  service token and requires that token to belong to the sandbox owner. Read
  access is not enough: otherwise send returns HTTP 404 `not_found`, even for
  an organization admin who can read the sandbox. Because the state checks run
  before the ownership check, that admin gets HTTP 409 `sandbox_terminal`
  instead when the sandbox cannot take a send (for example after it failed),
  or HTTP 409 `credential_binding_required` for a Modal sandbox with no bound
  model account. The request body is limited to 128 KiB; a larger body returns
  HTTP 503 `{"error":"viewer_access_denied"}`, so do not retry it unchanged.
- `GET /api/v1/events?sandbox=<sandbox UUID>`: the [sandbox event feed](README.md#stream-sandbox-events) accepts the viewer bearer for its bound sandbox.

The feed sends durable references for lifecycle transitions and runtime events.
On provider-native sandboxes, read logs directly to see output between transitions.
Use `viewer/logs` to retrieve message
content and `viewer/status` for current status. Save the last processed SSE ID
for reconnects and keep the opaque log cursor separately. Log pages request at
most 100 events and a 64 KiB provider byte budget. Reconcile mutable log
events by event ID. On unmount, abort the stream. If a grant expires, renew it
through your backend before reconnecting.

Use a same-origin application backend proxy for browser integration. Forward
Authorization and cancellation and disable response buffering for SSE.

Design decision: the token is an AES-GCM sealed, purpose-bound grant under
ARMADA_ENCRYPTION_KEY, containing the issuing bearer, exact sandbox and expiry.
It is never accepted as a general Armada principal. Every operation and stream
page reauthenticates the issuing service token and applies the same checks as a
direct call with that token (visibility for reads, ownership for send); revoking the service token or removing sandbox visibility ends access on
the next read. Revoking a parent token invalidates all its viewers; individual
viewer revocation is expiry-based. Key rotation invalidates outstanding grants.
No machine enrolment, runtime tunnel, exec, steering, lifecycle or org API is
exposed. No schema change or separate signing secret is needed.
