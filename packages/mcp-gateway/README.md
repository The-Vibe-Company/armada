# @armada/mcp-gateway

Standalone Bun-bundleable remote MCP broker/bridge. No SQL, environment reads,
server routes, launch changes, subprocesses or sandbox credential injection.
SDK **1.32.2**, Zod **4.6.7**, exact pins. Authorization reference:
https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization

## Exports / wiring

- `RemoteAuthType = auto|none|oauth|bearer|headers`: backwards-additive request/DTO
  contract. Registry must default omitted selection to **auto**, and retain bearer
  and custom-header values as write-only overrides.
- `createRemoteAuthResolver({fetch?}?)({url, transport, signal?})` →
  `RemoteDiscoveryResult`. A real SDK initialize proves public MCP reachability:
  `{authType:"none", state:"reachable", serverInfo, capabilities}`. A real 401,
  PRM and validated issuer discovery yield `{authType:"oauth",
  state:"authorization_required", issuer, resource, scope?, resourceMetadataUrl?}`.
  No client registration or grant is created by automatic discovery. Neither result
  persists a connection or reports a fake connected DTO. A malformed HTTP success
  is not MCP success. Registry chooses its transition only after this result and
  successful grant exchange where needed. Explicit transport remains required;
  HTTP-to-legacy-SSE fallback is not automatic. Caller can bound probe with signal.
- `discoverOAuthIssuer(issuer, fetch?)`: validated RFC8414/OIDC issuer metadata.
- `createOAuthBroker(OAuthBrokerOptions): OAuthBroker`
  - `connect({actorId, connectionId, resource, client?, scope?, resourceMetadataUrl?})`
    → `{authorizationUrl}`. `client` is issuer-bound preregistration, including
    optional client secret. Otherwise CIMD when advertised/configured, then legacy
    DCR. Resource challenge scope takes priority over configured/PRM scopes.
  - `callback({actorId, state, code, issuer?}): Promise<void>`
  - `access(actorId, connectionId, resource): Promise<string>`: control-server-only
    access token; **never** send this return value to a sandbox/dashboard.
  - `revoke(actorId, connectionId)` → `{upstreamRevocation: done|unsupported|failed}`.
    Local tombstone precedes upstream I/O. `done` means endpoint acknowledged the
    request, not independent proof that the provider invalidated every token.
- `createOAuthCallbackHandler({broker, redirectUri, actor})`: Request → Response.
  Mount on the broker's exact fixed callback URI, behind browser authentication.
  No return-target query parameter or upstream error text is reflected.
- `createClientMetadataHandler({clientMetadataUrl, redirectUri})`: public static
  CIMD Request → Response. Use precisely the same configuration as the broker.
- `createMcpGateway(GatewayOptions): McpGateway`
  - `handle(Request): Promise<Response>`: mount at a dedicated HTTPS MCP URL.
  - `invalidate(connectionId)`, `invalidateLease(leaseId)`, `close()`.
- Contracts: `OAuthStore`, `SecretBox`, `OAuthBrokerOptions`, `OAuthGrant`,
  `OAuthServerMetadata`, `StoredGrant`, `PendingAuthorization`, `GatewayLease`,
  `GatewayAuthorization`, `GatewayOptions`, `OAuthBroker`, `McpGateway`.
- Network: `endpoint`, `publicFetch`, `restrictedFetch`, `GatewayError`.
  Error codes: `denied`, `unsafe_endpoint`, `unsupported`, `needs_reconnect`,
  `busy`, `upstream`; `action` is safe actionable text, not upstream response text.

### Required adapter semantics (security boundary)

`OAuthStore` must persist **only vault ciphertext** and state hashes. Implement
`SecretBox` using the existing core `encryptSecret`/`decryptSecret` scheme; encode
ciphertext bytes for the string port. No new encryption key or plaintext column.

`generation(connectionId)` snapshots the connect generation even before any grant
exists. `StoredGrant` carries generation as well as version. `saveGrant(id, version,
sealed, generation, refreshOwner?)` is atomic version+generation CAS plus
non-revoked/enabled check. This fences a callback already consuming a code when
revoke and a subsequent new connect happen; version CAS with null alone cannot.
`claimRefresh(id, version, generation, refreshOwner)` carries a unique owner for
SQL rotation ownership checks.

`saveGrant` is atomic version CAS plus enabled/non-revoked connection check.
`claimRefresh` is atomic across processes and fenced by that same grant version.
Successful CAS changes the version and clears the claim. **Do not automatically
reclaim failed/abandoned refresh claims**: the old refresh token may already be
spent. A fresh browser authorization replaces the grant/claim. Contenders get
`busy` and must retry status, never blindly replay a tool call. `revoke` atomically
tombstones the connection, deletes its grant, invalidates pending flows/claims,
and defeats outstanding callback/refresh CAS. A callback cannot clear a tombstone;
a deliberate new connect lifecycle must do so under coordinator authorization.

`takePending` is one-time atomic consumption bound to actor and expiry. Store
pending ciphertext for at most ten minutes. Never log callback query strings,
upstream bodies, credentials or sealed-plaintext inputs. Store authorization
checks remain mandatory even when a state record exists.

`GatewayAuthorization.authenticate` must accept **only narrowly scoped gateway
leases**, not general Armada API bearers. Bind each immutable lease generation to
actor, sandbox, connection, org, visibility, endpoint and transport. Restore gets
a new short-lived lease. `assertActive` checks current membership, sandbox binding,
visibility, connection enabled state, expiry and revocation without a stale cache.
Personal grants require private actor-owned sandboxes; org sharing must be explicit.
`allow` must implement method/tool policy in both directions; tool annotations are
not policy. `upstreamHeaders` resolves public/bearer/custom-header/OAuth credentials
from the server-side vault. Incoming Authorization/cookies are never copied.
It can call broker `access` for OAuth. Do not return a broad Armada bearer here.

After disable/revoke/delete, **await `gateway.invalidate(connectionId)`**, not just
store mutation; after stop/lease revocation await `invalidateLease`. Broadcast these
invalidations to every gateway replica to terminate already-open streams. Requests,
upstream fetches and messages in either direction also recheck live authorization.
Sessions are in-memory: use sticky routing and invalidate on worker retirement.
Unknown sessions return 404, never attach to a replacement upstream session.

## Protocol / honest limitations

Actual SDK transports bridge JSON-RPC rather than reconstructing a tools-only
server. OAuth behavior targets the linked 2026-07-28 authorization specification.
The current official SDK 1.32.2 still supports MCP protocol versions only through
2025-11-25: the bridge explicitly negotiates that version, rather than pretending
it can terminate a newer wire transport. An upstream refusing compatible negotiation
is rejected. Full 2026-only protocol features require a newer official SDK/adapter;
this is an explicit compatibility limit, not claimed conformance. Initialization capabilities, tools/resources/prompts, cursors, notifications,
progress, cancellations and bidirectional messages retain their protocol payloads.
Separate upstream transport per downstream actor/lease/session. HTTP and explicit
legacy upstream SSE are supported; downstream is Streamable HTTP. No stdio process
is run here (#523 owns sandbox bootstrap).

Live SSE is streamed. A downstream request abort/cancel closes only that HTTP
response path: it is not an MCP cancellation notification and does not close the
session or sibling POST/GET streams. An abandoned POST's late messages are drained
and discarded without replay or rerouting. Explicit MCP cancellation notifications
still pass through policy/transport. Upstream transport errors close the session.
Explicit downstream DELETE attempts upstream HTTP `terminateSession` before local
close; upstream 405 or unavailable/revoked credentials do not prevent local cleanup.
The attempt has a cleanup-owned AbortController and deadline, independent of caller
request disconnects. `GatewayOptions.cleanupTimeoutMs` defaults to 5000ms and accepts
integers 1..30000. Cleanup uses ordinary setTimeout/clearTimeout with no exported
timer-injection port. The deadline also bounds credential lookup and
an injected fetch that ignores abort. Local session deregistration and both transport
closes run in finally; late attempt rejection remains observed. The scheduled deadline
is cancelled on fast completion. One cleanup task is shared by concurrent validated
DELETEs; no remote operation is automatically replayed. There is no bypass to revive
revoked credentials for cleanup. A Bun-fake-clock HTTP protocol fixture verifies the
session before expiry, 404 after expiry, closure of a pending POST response, cancellation
of the remote DELETE signal and safe late remote failure without wall-clock sleeps.

For SDK 1.32.2's HTTP client, async-local per-send scope preserves the originating
POST reader's request ID through its asynchronous JSON/SSE callbacks. Relayed server
requests/notifications use downstream `send(...,{relatedRequestId})`; replies retain
their own JSON-RPC IDs. Independent concurrent POSTs cannot borrow each other's
correlation. Initialized notifications/replies run in an uncorrelated scope so the
SDK's standalone GET stays distinct. This uses the pinned SDK's reader behavior,
covered by a POST-only transport regression (SDK Clients normally open GET and
would hide that defect). Legacy upstream SSE supplies no POST association; messages
without transport-proven provenance remain standalone, never guessed from active calls. No
ambiguous mutating POST is automatically retried. Streamable HTTP reconnection
retries are disabled; downstream Last-Event-ID replay explicitly returns typed
`unsupported` (409). There is **no durable event replay or cross-replica stream
resume**: reinitialize after disconnect without replaying uncertain calls. Native
harness prompt UI exposure is outside this package.

Only public HTTPS endpoints are accepted. The production dialer validates all DNS
answers, pins the selected address to the TLS socket, preserves hostname certificate
verification, and refuses redirects. IPv6 policy is conservative (including rejecting
2001/2002 ranges); private/local/mapped addresses are denied. Discovery/resource
URLs remain within resource origin. Authorization, token, registration and revocation
endpoints may each use a different HTTPS origin, as advertised by the exact validated
issuer's metadata. Each server-side operation is pinned to its own full advertised
URL (including path/query), not an origin-wide allowlist. Discovery uses exact
issuer-derived well-known URLs, never follows redirects, and checks the metadata
issuer by exact string equality. Token exchange/refresh cannot use registration or
revocation URLs, even when origins coincide; no endpoint from a token/registration
response can replace the stored metadata snapshot. Credentials are built afresh per
purpose, not copied between endpoints. Code/refresh and preregistered identity/secret
remain issuer-bound. All server-side dials still use the DNS-pinned public dialer;
no redirects are followed, including same-origin redirects. The authorization URL
returned to the browser uses only the advertised HTTPS authorization endpoint;
Armada does not server-fetch or proxy the provider's interactive login navigation.
A custom fetch is a production egress port, **not permission to use
unprotected global fetch**: it must retain DNS pinning/SSRF protections.

Both RFC8414 and OIDC discovery are parsed. An SDK OIDC schema omission is worked
around to preserve validated RFC9207 issuer-response and revocation metadata.
PKCE S256 advertisement is required. Callback issuer is exact string-compared,
mandatory when advertised; scope and canonical resource are bound to the flow.
Opaque upstream tokens cannot be independently introspected for audience; the
broker supplies RFC8707 resource in authorization, code and refresh exchanges,
and binds stored tokens to that resource/issuer. JWT signature validation or
provider-specific introspection is not claimed. Missing token expiry, missing
S256, unavailable registration, non-bearer tokens and endpoint incompatibilities
produce actionable states, not connected stubs. No refresh token means reconnect
on expiry. DPoP, custom client assertions, device grants and proprietary flows are
not automated. No third-party grant was created during development.

## Validation

Tests use an actual SDK client through the gateway to an independent SDK server,
including HTTP and an injected legacy SSE wire, plus injected OAuth HTTP fixtures.
No external network or wall sleeps. The malformed-status regression uses a raw
loopback HTTP peer and a process-isolated test dial override, exercising the native
Node HTTPS response callback with HTTP status 600. It does not mock Response and
proved the pre-fix asynchronous RangeError crash. Callback conversion now validates
status 200..599 and catches header/body/Response conversion failures, destroys the
incoming stream and rejects a typed upstream error without unbounded buffering. OAuth store fixture models CAS/tombstones;
production SQL/RLS and multi-replica invalidation need coordinator adapter tests.
The package's grant tests use the actual core encryption functions with an ephemeral
in-memory test key. All third-party values in fixtures are non-working placeholders.

## Registry520 adapter mapping / review blockers

The coordinator's `McpBrokerPort.connect(actor, connection)` can resolve an omitted
or `auto` authType with `createRemoteAuthResolver`, record the **real** result through
`discovered(id,generation,none|oauth)`, and invoke broker connect for OAuth. Bearer
raw strings, header JSON and preregistration JSON are write-only adapter inputs;
this package never loads DB credentials. Keep the shared control routes unchanged.

Map registry `begin(connectionId)` to an immutable generation snapshot. SQL
`rotate(id, owner, version, generation, ciphertext|null)` can implement the grant
CAS, provided it checks BOTH version and generation even for initial null grants.
`acquire(id, refreshOwner, seconds)` must additionally make an already-used or
uncertain refresh token **non-reusable durably**. A time-expiring lease alone does
not satisfy `claimRefresh`: after worker death, replaying that token risks losing
an upstream rotated grant. Persist an uncertainty/consumed marker before network
exchange (or an equivalent fenced token-removal/rotation transaction), and require
reconnect after abandoned claims. This is a concrete SQL adapter review requirement,
not something the package can fix with a local mutex. No migrations are included.

Registry lease `issue`/`validate(tokenHash,operation)` implements gateway
`authenticate`/`assertActive`; map `invalidateSandbox` to `invalidateLease` for
all affected lease IDs. Integration must broadcast revocations to live replicas.
The package exposes no sandbox-facing upstream credential API. The registry's
DTO should add `auto` and default to it, but persist connected only after real
public protocol success or completed OAuth, never while discovery is pending.

Endpoint queries such as `project_ref` and `read_only` are retained; userinfo,
fragments and credential-like parameters (`access_token`, `refresh_token`,
`client_secret`, `api_key`, `token`, `authorization`, `password`) are rejected.
Issuer metadata still undergoes exact issuer checks and purpose-specific endpoint pinning.

## Hosted browser callback composition

The deployed fixed broker `redirectUri` is **DASHBOARD `/auth/mcp/callback`**, not
an API-host browser session endpoint. Its Next handler reads the signed-in session,
then POSTs code/state/issuer to authenticated control
`/api/control/mcp/oauth/callback`. The control actor comes from verified authentication,
not request org/actor claims. It invokes `broker.callback({actorId,state,code,issuer})`;
the broker consumes actor/generation-bound pending state and exchanges with the
same exact dashboard redirect URI used at authorization time. Do not accept arbitrary
return URLs or trust a browser-supplied org. Keep codes/state out of request logs.
`createOAuthCallbackHandler` remains available for a deployment where browser auth
and the callback actually share a host; it does not establish Railway browser auth.
No control/Next route is wired by this package. Multi-replica stream cancellation
also remains a coordinator broadcast-composition obligation, not an implemented
cross-process guarantee here.

Endpoint trust follows [RFC8414 sections 2 and 3.3](https://www.rfc-editor.org/rfc/rfc8414.html#section-3.3):
validated issuer metadata advertises endpoint locations; issuer equality, rather
than endpoint-origin equality, binds that metadata to the selected AS. Callback
issuer and resource-indicator rules follow the
[MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).
The SDK's `client/auth.js` independently constructs token and registration HTTP
requests from their respective advertised metadata fields. This package supplies
separate exact-URL/no-redirect fetch wrappers at those calls rather than broadening
one credential-bearing origin allowlist. Existing wire-version, DPoP, proprietary
auth, durable replay and exact resource-identifier limitations above remain; ordinary
cross-origin AS endpoint layouts are no longer an incompatibility.
