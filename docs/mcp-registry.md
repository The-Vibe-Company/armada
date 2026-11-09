# MCP registry and privacy (#520)

## Frozen API (with coordinator's additive auto clarification)

Authenticated POST /api/v1/mcp/{list,create,update,connect,status,revoke,delete}.
All bodies include org (UUID); all except list/create include id (connection UUID).
Selected org membership is checked, even when unconfigured.

Create/update take the complete McpConnectionInput: name, scope (personal|org),
transport (http|sse|stdio), url?, command?, args? (string array), authType?
(auto|none|bearer|headers|oauth), authentication? (write-only opaque string).
Remote definitions default to auto. stdio defaults to none. HTTPS definition URLs
preserve the resource query exactly (including order, repeated keys and encoding),
allowing project_ref/read_only and similar ordinary parameters. Userinfo and
fragments (even empty fragments) are refused. Credential-like query names are
refused after URL decoding and case/separator normalization: token, access_token,
api_key, password, secret, client_secret, authorization, credentials, signing/
private keys, auth/key/sig/signature/jwt/bearer and their token/secret variants.
Put credentials in write-only authentication instead. SSRF/network destination
checks belong to the broker, not this registry.

Authentication is an opaque string encrypted unchanged, parsed/validated as follows:
- bearer: raw nonempty value, no CR/LF; never a URL or argv field.
- headers: JSON object mapping valid HTTP header names to string values without
  CR/LF (not an array/null, not a JSON string). The broker owns transport header
  policy and upstream verification.
- oauth: optional preregistration JSON object (not array/null). The registry only
  validates JSON/object shape; the OAuth broker must validate supported registration
  fields, client ID/secret types, issuer association and fixed callback policy.
  The object remains encrypted/write-only, including client secrets.
- auto/none: no authentication payload. Choose explicit oauth for preregistration,
  or bearer/headers for overrides. All remain not_connected until real verification.

Scope is immutable: sharing requires a new explicit org definition
and grant, never migration of a personal grant. Org changes/connect/revoke/delete
require admin. Metadata updates clear old authentication and invalidate old leases;
resubmit authentication or reconnect.

Responses: list {connections:McpConnectionDto[]}; create/update/status {connection};
connect {connection,authorizationUrl?}; revoke/delete {ok:true}. DTO fields match
#520, with additive authType auto. No ciphertext/authentication is serialized.
Saving credentials/definitions is not upstream verification: initial status is
not_connected. Absent broker returns unavailable and an actionable lastError,
never an authorization URL or fake connected state.

## Core exports and integration ports

All exported from @armada/core in connections.ts:
- McpConnectionDto, McpConnectionInput, McpRegistry, McpBrokerPort.
- createSqlMcpRegistry(sql,key): real registry; vault AES-GCM encryption.
- createSqlMcpGrantPort(sql): begin(connectionId) explicitly reconnects and fences
  old work; discovered(connectionId,generation,none|oauth) commits a real probe's
  auto result (public connected or OAuth not_connected); acquire(connectionId,
  refreshOwner,seconds?) leases refresh exclusively; rotate(id,refreshOwner,
  version,generation,ciphertext|null) CAS-commits only within the current refresh
  lease. McpGrantSnapshot is trusted-server-only ciphertext and fencing metadata.
- createSqlMcpLaunchPort(sql,registry): validate(actor,ids,visibility) before fork,
  bind(sandboxId,ids) after recording. SQL trigger independently refuses personal
  grants on org sandboxes, mismatched owners/orgs, removed memberships and revoked
  or disconnected grants.
- createSqlMcpLeasePort(sql): issue({sandboxId,connectionId,tokenHash,operations,
  expiresAt}), validate(tokenHash,operation), invalidateSandbox(sandboxId).
  Only a random opaque token's lowercase SHA-256 digest is stored. Operations:
  tools/resources/prompts. Validation returns McpLeaseClaims|null, not upstream
  credentials. Grant revocation/changes, sandbox stop/failure/deletion/generation
  change and membership removal immediately fence authorization.
- Structural aliases: McpGrantPort, McpLeasePort, McpLaunchPort.

ControlOptions.mcp accepts {registry,broker?}; startServer wires the SQL registry.
HandlerOptions.connections and ToolContext.connections accept the structural
LaunchStores.connections port. Coordinator must wire broker/runtime delivery
before enabling selected MCP launches. Absent wiring rejects nonempty selections
before fork; no false successful setup. OAuth worker owns probe HTTP, discovery,
issuer validation/fixed callbacks, upstream verification, capability/account
metadata and gateway proxy. Actual broker connect/status reads may resolve auto
to none/oauth through discovered; the HTTP DTO is reread after the broker call.

## Privacy and #509 integration

LaunchRequest adds visibility? (private|org) and connections? (UUID array).
Visibility defaults to the source golden's, preserving existing behavior. Org
goldens can launch owner-only forks without rebuilding; private-to-org is refused.
Migration 20261109020000_mcp_registry.sql snapshots old visibility and the old
private golden-owner access boundary into sandboxes.visibility/access_owner_id.
New forks use their launch owner. RLS and privileged server queries authorize
sandbox access independently of golden visibility. All tools/logs resolve through
scoped data; scoped updates and cleanup carry the same boundary.

Provider foundation #525 is integrated in the worktree: neutral provider IDs,
immutable Modal workspace/environment/App binding and provider mismatch rejection
coexist with independent access visibility. The restrictive public Modal-handle
insertion policy is preserved. Sandboxes persist source_golden_visibility, derived
from the golden on insert and immutable thereafter. SandboxView.sourceGoldenVisibility
carries it separately from access visibility into ProviderRegistry.resolve;
provider factories use this source scope for management credential resolution.
A private fork from an org golden therefore keeps org provider credentials even
when the launcher has a personal Modal pair. Golden selection remains selected-org
scoped and model choices are preserved. No dashboard/gateway/runtime files were edited.


## #523 prerequisite ports: durable uncertainty, callback and replica invalidation

All schema additions remain in the unapplied 20261109020000 migration; provider
10000 and model 00000 are not modified.

### Refresh uncertainty

McpGrantPort.acquire atomically sets refresh_consumed BEFORE returning ciphertext
for upstream I/O. A worker must acquire before exchanging a refresh token.
Expiry does NOT clear consumption: a second worker cannot reuse an old refresh
token after an uncertain exchange. A consumed expired claim is exposed as
needs_reconnect in registry DTOs. Successful rotate checks owner, version,
generation, unexpired lease and consumed state, then atomically saves ciphertext
and clears the claim. Failed/abandoned exchanges remain fenced indefinitely.

Only an explicit fresh OAuth reconnect calls begin: it increments generation and
version, clears old ciphertext, and resets consumption. New callbacks must use
their pending flow's generation, not look up a replacement generation and reuse
old callback material. Prior refreshes and pending callbacks cannot commit into a
deliberately reconnected grant. Saving a new complete definition also replaces
old authentication and advances its generation; it cannot recover an old token.

### Pending OAuth

Exports: McpPendingOAuthFlow, McpPendingOAuthPort,
createSqlMcpPendingOAuthPort(sql,encryptionKey).

- put({stateHash,actorId,orgId,connectionId,generation,expiresAt,payload}): hash is
  SHA-256 hex of random OAuth state, never raw state. Payload is sealed internally
  with the existing vault AES-GCM scheme. Put checks current actor authorization,
  org, connection, generation and future expiry.
- take(actorId,stateHash): atomic single-use DELETE/RETURNING conditioned on
  matching actor, unexpired state, current membership/admin permission for shared
  grants, connection/org and current nonrevoked generation. A different actor
  cannot consume the flow. Returns decrypted payload only to the trusted broker.
- purgeExpired(): server maintenance for expired sealed flows.

The pending table has RLS and explicit service-only grants; no JWT reads/writes.
The broker owns payload schema, state hashing, PKCE/issuer/registration policy.

### Dashboard browser callback

Provider redirects to the fixed configured dashboard URL:
https://<dashboard>/auth/mcp/callback. The Next route reads the browser session
and POSTs code/state/issuer server-side using that user's Supabase bearer to
POST /api/v1/mcp/oauth/callback. No client-supplied org or connection ID
selects a flow. The control route authenticates the actor, then delegates to:

McpBrokerPort.callback?(actorId,state,code,issuer?)
  -> {orgId,connectionId,status}

The broker resolves trusted pending state and validates actor/membership/current
generation before token I/O/CAS. The controller rereads the safe registry DTO
under that actor and the returned trusted org/connection. Absent callback wiring
returns actionable unavailable, not successful authorization. Existing
connect/status routes and response shapes are unchanged. No upstream HTTP is
performed by this control route.

### Cross-replica live revocation

Exports: McpInvalidation, McpInvalidationPort, createSqlMcpInvalidationPort(sql).

Database triggers transactionally append service-only outbox metadata on grant
generation/revocation changes, definition changes/deletion, sandbox generation
changes and membership removal/role changes. Rollback rolls back the event too.
No credential, hash or sealed payload is included in event records.

Each gateway replica has its own durable replica UUID:
- pending(replicaId,limit=100) returns all unacknowledged metadata events.
- Close affected open streams, then acknowledge(replicaId,eventIds).
- Other replicas must independently drain/ack; this is NOT a competing-consumer
  queue and an in-process callback alone is not distributed revocation.
- Acknowledgements are per event, not a high-water cursor: a lower sequence ID
  committed late is still delivered. Replays after a crash are intentional.
- Consumer must poll while streams are open. Lease validation still applies on
  every request/new stream. Actual gateway polling and stream closure belong to
  #521 integration; the SQL port itself does not pretend to close remote streams.
- No automatic event retention deletes events ahead of lagging replicas.

## Canonical API-only routes and lifecycle (#520 acceptance)

The server accepts MCP control only under /api/v1/mcp/*. Dashboard same-origin
proxying belongs to the dashboard; /api/control/mcp/* is not a server alias.
Existing list/create/update/connect/status/revoke/delete contracts are unchanged.

### POST /api/v1/mcp/set-enabled

Body: {org: organization UUID, id: connection UUID, enabled: boolean}.
Response: {connection: McpConnectionDto} from the actual registry.

Export: McpRegistry.setEnabled(userId,orgId,id,enabled). The real implementation is
part of createSqlMcpRegistry(sql,key); no new adapter factory is needed.
Authorization matches definition modification: personal owner only, explicit org
member plus admin for shared org grants. Invalid/nonboolean enabled is rejected.
No connection scope or owner is changed.

An actual enabled-state transition updates the definition and grant in ONE SQL
statement. It increments grant generation/version, revokes the old grant, clears
encrypted authentication and refresh ownership, and emits transactional durable
invalidation events. Existing gateway leases, pending OAuth and pending refresh
commits are fenced. Disabled grants cannot begin/connect/acquire/rotate/discover.
Every gateway replica must drain its invalidation feed and close matching streams.
Calling set-enabled with the existing state is idempotent, not token destruction.

The deliberate conservative policy retains NO encrypted authentication across a
toggle: re-enabling returns not_connected and requires new authentication and
real verification/fresh OAuth connect. It never clears a consumed-refresh fence
or resurrects a revoked token. Only explicit fresh begin clears consumption
while also destroying old ciphertext and advancing generation.

### POST /api/v1/mcp/sandbox-connections

Body: {org: organization UUID, id: sandbox UUID}.
Response: {connections: McpConnectionDto[]}.

Export: McpRegistry.sandboxConnections(userId,orgId,sandboxId), implemented by
createSqlMcpRegistry. Current org membership, selected org and independent sandbox
visibility are checked (including private owner boundary, admins not exempt).
An inaccessible or wrong-org sandbox is not_found. Actual mcp_bindings are joined
to their definition/grant; no assumed sandboxes.connections array exists.
The safe DTO reflects disabled, revoked or expired-consumed/needs_reconnect
state at read time. No bindings means an empty list, not inferred defaults.
Personal definitions cannot leak through another owner's sandbox. No credential
or ciphertext is selected.

### Callback and fixed return

POST /api/v1/mcp/oauth/callback is the canonical server callback endpoint.
The dashboard's fixed /auth/mcp/callback reads its browser session and sends
state/code/issuer in an authenticated server-side POST. Org/connection selection
comes ONLY from the actor-bound encrypted pending state, not client body fields.
After callback completion the dashboard redirects to the fixed Connections page
(/connections), never a client-supplied return URL. The control API returns a safe
connection DTO, not a redirect target; no dynamic return-path input is supported.

Broker521 wiring is still required: ControlOptions.mcp.broker.callback must use
createSqlMcpPendingOAuthPort, current membership/generation checks and fenced
grant writes. The route delegates, performs no upstream fetch and reports
unavailable if unwired. SQL ports and route availability are NOT a claim that
live OAuth or live stream shutdown has been integrated.
