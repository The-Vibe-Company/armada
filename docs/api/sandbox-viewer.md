# Embed a sandbox session

Your backend calls `POST /api/v1/sandbox/viewer-token` with its Armada service
bearer and JSON `{ "id": "<sandbox UUID>" }`. It must authorize its own product
user before minting. The response is `{ token, expiresAt }`. Forward only this
opaque token to the browser. It expires after five minutes; renew through your
backend. Never send the service bearer to the browser or put tokens in URLs.

The viewer bearer works only on these routes:

- `POST /api/v1/viewer/logs`: `{ "cursor": "<optional opaque cursor>" }`.
- `POST /api/v1/viewer/status`: `{}`.
- `POST /api/v1/viewer/send`: `{ "message": "...", "requestId": "<UUID>" }`.
  Supply a stable requestId when retrying runtime sends. Ordinary send admission
  still applies (busy turns may refuse a new message).
- `GET /api/v1/viewer/events?cursor=<URL-encoded opaque cursor>`: SSE over fetch
  with `Authorization: Bearer <viewer token>`. Native EventSource cannot set this
  header. Each `page` event contains the ordinary logs response. Save its JSON
  `cursor` for reconnects; do not derive a cursor from event text. Last-Event-ID is
  also accepted as an input cursor, but JSON cursors are authoritative.

Pages contain at most 100 events and request a 64 KiB provider byte budget.
Streams poll the existing incremental reader when idle, at one second intervals,
and read one page per consumer pull without a background producer. Abort the fetch
on unmount. An `access-ended` event or end of stream requires reauthorization or
reconnect. After a transport error, fall back to `viewer/logs` using the saved
cursor and a bounded polling cadence; reconnect SSE when available. Treat cursors
as opaque and handle a rejected/expired history cursor by reopening history.
These are the same provider cursors and public events as ordinary logs, including
native Boat's mutable-row behavior. Clients should use the existing event reducer
rather than assuming append-only messages.

Use a same-origin application backend proxy for browser integration. This API
adds no permissive CORS or cookie authentication. Proxy only the viewer routes,
forward Authorization and cancellation, and disable response buffering for SSE.

Design decision: the token is an AES-GCM sealed, purpose-bound grant under
ARMADA_ENCRYPTION_KEY, containing the issuing bearer, exact sandbox and expiry.
It is never accepted as a general Armada principal. Every operation and stream
page reauthenticates the issuing service token and uses the existing visibility
checks; revoking the service token or removing sandbox visibility ends access on
the next read. Revoking a parent token invalidates all its viewers; individual
viewer revocation is expiry-based. Key rotation invalidates outstanding grants.
No machine enrolment, runtime tunnel, exec, steering, lifecycle or org API is
exposed. No schema change or separate signing secret is needed.
