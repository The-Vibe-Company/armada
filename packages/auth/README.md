# Auth maintenance

- Bearer authentication reads the token and current organization membership for
  each request. Keep these reads uncached so revocation or membership removal
  takes effect on the next request. Use a single database snapshot where the
  store supports a joined read.
- The SQL store's `sessionMemberships` checks session validity and user status
  with current memberships. It returns `null` for an invalid session and an
  empty list for a valid session without organization memberships. The server
  owns the SQL store. The CLI calls the Armada API.
- Armada stores lowercase SHA-256 token hashes. Show a new service token once
  and keep raw tokens and keys out of persisted state, user-facing errors, and
  logs. Keep Supabase response bodies out of user-facing errors.
- Service tokens have no scheduled expiry. MCP access tokens expire one hour
  after creation. Refresh tokens are client-bound and expire for renewal after
  30 days. Bearer authentication rejects refresh tokens. OAuth authorization
  codes can be consumed once. Keep the PKCE verifier in memory or in the
  encrypted cookie.
- Set `ARMADA_PUBLIC_URL` to the public HTTPS origin. Local HTTP is supported
  for development. The MCP OAuth resource is that origin plus `/mcp`, and
  the granted scope is `armada`. OAuth callback matching uses the exact
  registered URI. Registration supports HTTPS, loopback HTTP, and permitted
  native schemes.
- Enforce raw body limits on bytes read from the stream, even when
  `Content-Length` is absent. When a body exceeds the limit, reject immediately.
  Stream cancellation is advisory and may never settle.
