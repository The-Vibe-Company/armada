# Connect MCP servers once for Armada sandboxes

Research date: 2026-11-08. Scope: design and implementation readiness, not product
implementation. Evidence comes from the current v2 repository, its open issues/
PRs, official harness documentation, published Boat SDK, MCP specification and
OAuth RFCs. Recommendations below are design inferences unless marked confirmed.
The researcher created no resources or grants. The coordinator subsequently ran the bounded public-MCP probes recorded below; no third-party OAuth grant was created.

## Recommendation and decision options

**Build a connection registry and OAuth broker in Armada, with a scoped remote
MCP gateway and sandbox-local stdio support.** Users connect a service once in
Armada; both harnesses receive equivalent generated configuration. The gateway
keeps upstream refresh tokens out of sandboxes and makes revocation effective
without waiting for a harness restart. Stdio servers needing local repositories
still run inside the target sandbox, not on the Armada control server.

| Option | Strength | Cost / limitation |
| --- | --- | --- |
| Inject upstream tokens/config directly | Smallest first implementation; native client connection | Tokens reach the sandbox; refresh, rotation and restart differ by harness; copied snapshots retain risk |
| Scoped gateway for every remote server | One browser login, centralized refresh/policy/revocation | Must implement real MCP proxy semantics and isolate grants; cannot execute a filesystem-dependent stdio server remotely |
| **Hybrid: gateway remote, local pinned stdio** | Best common user flow and broadest actual compatibility | Two execution locations, shared registry/policy and two harness adapters |

Do not advertise "any URL works with one click." Some upstreams require manual
OAuth client registration, restrict callbacks/client identity, issue no refresh
token, require interactive elicitation, or are reachable only on a local/private
network. OAuth availability does not imply permission to share a human identity.
[Authorization requirements][auth], [registration][registration].

## Easiest end-user flow

1. **Connections → Add MCP server**: paste a URL or import a standard MCP JSON/
   command description. Show the resolved transport and execution location;
   importing a command must not execute it on the Armada server.
2. Default to **Personal connection**. Detect no-auth, bearer/custom headers or
   OAuth; open a browser consent flow for OAuth. Put manual client ID/secret and
   package settings under an advanced section when discovery cannot automate it.
3. Discover tools, resources and prompts. Show connected account, requested
   scopes, available operations and proposed autonomous-use policy. Save one
   stable connection ID, not a credential embedded in a golden.
4. Launch from any authorized Boat or Modal golden with selected connections.
   Personal connections require a **private sandbox**, even if its golden is
   shared. No separate golden build is needed for a private launch.
5. Show per-connection state: ready, needs sign-in, blocked, unavailable, applying
   update. Reconnect, disable or revoke in Armada. Existing and restored sandboxes
   reconcile the desired connection revision before accepting the next turn.

An org admin may separately approve an **Org connection** backed by an explicitly
shared integration/service account. Sharing a server definition is distinct from
sharing its credential: org members can use the definition while each authenticates
personally, or use a deliberately shared org grant. Never silently promote a
personal OAuth grant to an org default.

## Repository findings and the identity prerequisite

**Confirmed:** v2's `Provider` has no MCP-connection operation or launch option;
Boat prompts accept text/model/effort/fast, while the existing credential resolver
handles model and GitHub credentials. A search found no existing outbound MCP
configuration implementation. The inbound Armada `/mcp` server is a different
role; its OAuth client/token tables are not an upstream connection store.
[Provider](../../packages/core/src/provider.ts),
[Boat adapter](../../packages/provider-boat/src/provider.ts),
[credentials](../../packages/core/src/credentials.ts),
[HTTP server](../../packages/mcp-server/src/http.ts).

**Confirmed security constraint:** sandbox visibility follows its golden in the
current service SQL. Org members can retrieve an org-visible sandbox and call
`exec`/send through the same visibility check. Another member could therefore use
the launcher's personal MCP gateway lease from the sandbox, or drive its harness,
even when all upstream OAuth tokens stay on the server. Token brokerage alone
does not fix this; neither does issuing a fresh token for each message.
[Visibility predicate](../../packages/mcp-server/src/data.ts),
[tool authorization and exec](../../packages/mcp-server/src/tools.ts).

**Required design change:** persist sandbox visibility independently from golden
visibility, allowing an owner-only sandbox forked from an org golden. Update RLS,
service SQL, control/logs, dashboard projections, notifications, shell/SSH and
every command path together. For personal grants, only that owner controls or
reads the sandbox; org admins do not gain implicit personal access. A shared
sandbox accepts only explicit org/shared grants. Existing rows preserve current
visibility by deliberate migration/backfill, not an accidental default.

Pin each connection grant to its authorizing principal. Later sends do not
silently reinterpret it as the sender's identity. A shared-org sandbox acts as
the configured org integration; a private sandbox acts as its owner. Changing
principal requires a new isolated binding, not overwriting an environment variable
in a live shared process. Log initiating Armada actor and upstream grant subject
separately when both are known; a gateway lease cannot authenticate who typed a
shell command inside a fully controllable sandbox.

Provider routing still derives from immutable provider-specific goldens (#509).
Connection IDs/policy may be provider-independent, while sandbox installation,
lease generation and lifecycle are provider-specific. #510 supplies the durable
runner seam; PR #505's server-owned private checkout/SSH flow should install only
credential-free artifacts in builders. PR #518 persists launch model/effort and
supports per-turn overrides: follow that propagation pattern for connection IDs
and desired revision, keeping MCP selection orthogonal to model choice.
[#508](https://github.com/The-Vibe-Company/armada/issues/508),
[#509](https://github.com/The-Vibe-Company/armada/issues/509),
[#510](https://github.com/The-Vibe-Company/armada/issues/510),
[#505](https://github.com/The-Vibe-Company/armada/pull/505),
[#518](https://github.com/The-Vibe-Company/armada/pull/518).

## Confirmed harness surfaces and limits

| Surface | Confirmed behavior | Armada consequence |
| --- | --- | --- |
| Claude Agent SDK | `mcpServers` config supports stdio, HTTP and legacy SSE; remote headers/env credentials; SDK does not run browser OAuth | Broker OAuth in Armada; supply only gateway lease; inspect startup status rather than assume tools loaded |
| Claude live session | `setMcpServers`, `toggleMcpServer`, reconnect are available, with different ownership/version semantics | Manage a known set and reconcile results/errors; do not assume a set call replaces every startup/config/plugin server |
| Claude CLI | User/local definitions in `~/.claude.json`, project `.mcp.json`; project overrides user by name | Use controlled config/provenance so repository definitions cannot replace trusted connections |
| Codex config | stdio and Streamable HTTP; bearer env, static/env headers; user config and trusted project config | Generate typed TOML, use env-backed lease, preserve unrelated model settings |
| Codex app-server | Config write/reload, status list, OAuth login, tool call, resource read and elicitation RPCs | Use pinned app-server schema and verify each loaded thread applied a revision |
| Legacy SSE | Claude directly documents it; current Codex supported-transport list does not | Gateway or a pinned local stdio bridge translates upstream SSE to a supported downstream transport |

Sources: [Claude MCP SDK][claude-mcp], [Claude SDK types][claude-types],
[Claude CLI][claude-cli], [Codex MCP config][codex-mcp], [Codex app-server][codex-app].
Absence from Codex's supported list is a compatibility gap to validate, not proof
that no possible Codex version can ever consume SSE.

Claude tool names use `mcp__server__tool`. Its SDK exposes built-in resource
listing/reading tools; CLI prompts become slash commands. Headless/SDK
`list_changed` handling refreshes tools, unlike interactive sessions which also
refresh resources/prompts. Version-pin and reconnect explicitly where needed.
[SDK resource types][claude-types], [CLI resources/prompts/update behavior][claude-cli].

Codex app-server confirms resources and tool operations, but the inspected
documentation does not establish a general `prompts/list`/`prompts/get` RPC.
Do not claim native prompt parity from tool discovery. Preserve prompts in the
gateway and implement an explicit Armada prompt picker/resolver feeding expanded
messages into the harness when necessary; test role/content/resource handling.
Do not silently discard resources/prompts or call a tools-only proxy full MCP.
[Documented app-server surface][codex-app], [MCP server features][features].

**Boat integration evidence:** inspected published `@boatdev/sdk`1.13.0 contains
no MCP field/API in its TypeScript/README surface, so Armada must bootstrap the
native harness configuration rather than assume a provider MCP endpoint.
The coordinator subsequently proved **public HTTP first-start loading in both
managed harnesses** on two fresh idle Armada sandboxes from the existing golden:

- Codex: `codex mcp add armada-docs-probe --url https://developers.openai.com/mcp`
  before first managed turn. Actual event tool name:
  `mcp:armada-docs-probe/search_openai_docs`; result156hits.
- Claude: `claude mcp add --transport http --scope user armada-docs-probe
  https://developers.openai.com/mcp` before first managed turn. Actual event tool:
  `mcp__armada-docs-probe__search_openai_docs`; result156hits.

No shell/HTTP fallback simulated those MCP calls; events recorded the native tool
invocations. These probes used the older deployed account model defaults
(Codex event model `gpt-5.6-terra`, Claude `claude-sonnet-5`), unlike the explicit
Opus5.5/GPT6.1 implementation workers. Both probe sandboxes were stopped afterward.
The result does **not** prove OAuth, headers/refresh, stdio, live reload, resources,
prompts or stop/restore. Validate those before promising complete parity; do not
silently replace the managed launch engine when a live-reload path is unavailable.
[Published first-party SDK tarball][boat-sdk],
[current managed adapter](../../packages/provider-boat/src/provider.ts),
[public read-only MCP used for the probe](https://developers.openai.com/mcp).

## OAuth broker: registration, refresh and revocation

The current MCP revision is **2026-07-28**; OAuth 2.1 is still referenced as a
draft. HTTP authorization uses protected-resource discovery (RFC 9728), then
validated AS/OIDC metadata. Support pre-registration, advertised CIMD and legacy
DCR fallback; DCR is deprecated compatibility, not universal. CIMD identifies a
client, not an already-authorized account. An upstream may require a registered
Armada client and approved redirect URI. [Current spec][auth], [registration][registration].

Use authorization-code + PKCE, one-use state, exact redirect allowlist and issuer
binding. Request tokens for the upstream resource/audience; never forward an
Armada login or gateway token upstream. Store issuer, resource, client binding,
granted scopes, encrypted tokens, expiry and rotation version per grant. Reuse
the repository encryption helper; token hashes alone cannot refresh an upstream
OAuth token. [Authorization rules][auth],
[existing crypto](../../packages/core/src/crypto.ts).

Serialize refresh per grant and compare-and-swap rotated refresh credentials;
retry workers reload the winner rather than reuse an invalidated refresh token.
The current GitHub refresh flow is a useful local pattern. No refresh token is
guaranteed; `offline_access` is requested only where advertised. Expose
`needs_reauthorization` after rejection, scope increase or expiry; do not launch
a browser in the sandbox or disable the server without reporting it.
[Refresh requirements][auth], [existing GitHub rotation](../../packages/core/src/github.ts).

Disconnect immediately revokes local leases, disables bindings and clears active
proxy state. Attempt upstream revocation where its AS supports RFC 7009, then
delete encrypted credentials according to policy. Report local disconnection
separately from upstream revocation success; a universal upstream revocation
endpoint is not promised. [Token revocation][revocation].

## Concrete gateway and installation design

Create an upstream client and a downstream MCP server, **not a bearer-token
passthrough proxy**. Use one downstream endpoint per selected connection,
for example `/sandbox-mcp/<connection-id>/mcp`, and a stable sanitized alias in
each harness. This avoids aggregate tool-name and resource-URI rewriting; retain
upstream schemas, instructions, annotations, structured output and pagination.
Bind opaque lease tokens to gateway audience, sandbox, generation, owner/org,
explicit connection IDs, allowed methods/tools and expiry. Check live membership,
grant state and policy revision on each call. Store token hashes, not raw leases.

Keep upstream clients/legacy session state isolated by authorization context and
conversation where required. Never share caches, handles or resource contents
across users just because their URLs match. The latest spec removed protocol
sessions/initialize and changed subscription/version metadata; older deployed
servers still use earlier lifecycle semantics. Pin SDKs and implement/test each
supported version on each gateway leg, rather than blindly forward headers or
assume `Mcp-Session-Id` is always required. [2026 changes][changes], [transports][transports].

The proxy must preserve advertised resources/templates/prompts, content blocks,
progress, cancellation and change notifications, including request-required
interaction or elicitation where negotiated. Reject unsupported negotiated
features explicitly instead of advertising them. Reserve arbitrary opaque
extensions for tested transparent handling; a gateway is not automatically
compatible with every future extension. [Features][features], [resources][resources].

At launch, resolve explicit binding IDs after authorization, mint generation
leases, install generated Claude/Codex config and any stdio packages, verify
discovery, then start the requested prompt. A required connection failing to load
must fail visibly before the task runs; optional connections have explicit
status. Secrets must never enter logs, command arguments, repository config,
goldens or durable model/prompt events. Use protected stdin/runner transport and
ephemeral configuration; PR #505's secret-on-stdin approach is relevant.

Store desired bindings and policy revision on the logical sandbox, separate
from the golden and model choice. For live updates, revoke removed gateway grants
first, then reconcile each conversation using Claude live MCP methods or Codex
atomic config writes plus reload/status. "Reload queued" is not "applied".
Upstream token rotation normally stays invisible behind the gateway. For local
stdio credential/config changes, stop/restart the owned MCP child and verify
catalog readiness at a safe boundary. Changes cannot undo already-completed
side effects, and upstream cancellation may be best effort.

On stop/checkpoint, keep only non-secret desired binding references, aliases,
versions and session metadata. Revoke generation leases and scrub config/auth
caches before snapshot; restore obtains fresh leases and current policy/grants
before any turn or stdio child starts. An old snapshot must not resurrect a
revoked connection. Never copy a Boat snapshot to Modal: each golden remains
provider-specific, while connection definitions can be reused after fresh auth.

## Permissions, arbitrary stdio and URL security

**Gateway policy is the enforcement boundary.** Tool annotations are hints, not
proof of safety. Filter discovery and authorize actual calls; do not rely only
on a model-visible allowlist. Define preauthorized autonomous actions per
connection, with explicit denials and optional approval escalation. Current Boat
capabilities have `approvals: false`; required human approval needs an Armada
approval workflow or a visible refusal, never automatic approval or a hanging
headless prompt. Do not advertise that workflow before it exists.
[Current capabilities](../../packages/provider-boat/src/provider.ts),
[MCP tool safety][features].

Auth consent and tool/action consent are separate. Preserve identity-specific
consent before sharing a static upstream OAuth client across Armada users.
Treat server descriptions, instructions and output as untrusted input; upstream
OAuth scopes plus gateway allowlists should bound actions independently of
prompt instructions. [Confused-deputy and token-passthrough guidance][security].

For remote URLs, validate the submitted URL and every discovered metadata,
authorization/token/registration endpoint and redirect. Enforce HTTPS, prevent
userinfo/token-bearing URLs, constrain scheme/port, block loopback/link-local/
metadata/private ranges by default and revalidate DNS/redirect destinations.
Private-network servers need an explicitly approved network/agent route, not
relaxed global SSRF checks. Never let a tool choose a different upstream host
while retaining the grant. Pin resource/issuer independently of display alias.
[SSRF, issuer and URL guidance][security].

For stdio, store typed executable/argv/cwd/env-reference metadata, not a shell
string. Resolve approved packages at exact versions with lock/integrity evidence;
preinstall or use a reproducible artifact rather than floating `npx -y latest`.
Run only inside the selected tenant sandbox under an explicit package trust
policy. Give each child the minimal environment and repository roots; avoid
inheriting model keys, GitHub keys or gateway leases unrelated to it. Arbitrary
package code can read files available to that Unix user: an env allowlist alone
is not an isolation boundary. Stronger separation may require a separate user,
container and intentional workspace mount. [Local-server compromise guidance][security].

If a local stdio server needs an upstream API key, that credential necessarily
enters its sandbox unless its API supports a separate scoped proxy. Revoking an
Armada binding stops the managed child but cannot erase copies that arbitrary
code already made; immediate effective revocation requires upstream revocation
or short-lived upstream credentials. Present this distinction from gateway-only
remote connections explicitly rather than promise identical secret containment.

An executable on the user's Mac or `localhost` server cannot magically run in a
Linux cloud sandbox. The import flow must ask for a portable package/artifact,
a reachable endpoint, or an explicit network bridge. Centrally hosting all stdio
servers changes workspace/file semantics and is not a universal substitute.

## Persistence and affected files

Suggested new records: connection definition/revisions; user/org OAuth or API-key
grant; org policy; desired sandbox bindings; short-lived generation lease; and
redacted connection audit/status. Separate shared definitions from grants.
User grants remain owner-only; org grant creation/rotation requires org admin.
Do not copy the model resolver's `user > org` fallback blindly: an explicitly
chosen connection failing must not silently execute through another identity.

| Area | Expected changes |
| --- | --- |
| `supabase/migrations`, generated types | New tables/grants/RLS, independent sandbox visibility, uniqueness and revisions |
| `packages/core/src/provider.ts`, launch/sandbox/store types | Typed connection references/install lifecycle, persisted visibility and effective bindings |
| `packages/core/src/credentials.ts`, `vault.ts`, `crypto.ts` | Upstream grant storage/resolution using existing encryption; new credential categories rather than model env reuse |
| New broker/gateway module or package | OAuth client/discovery, refresh, scoped leases, versioned proxy, URL policy |
| `packages/mcp-server/src/control.ts`, `http.ts`, `data.ts`, `serve.ts`, `tools.ts` | Connection CRUD/login callback/status/policy endpoints, factory context, per-sandbox auth; isolate from inbound Armada MCP OAuth |
| `packages/agent-runtime`, Claude/Codex drivers | Typed config renderer, controlled process env, live reconciliation, readiness/checkpoint cleanup |
| `packages/provider-boat`, future `packages/provider-modal` | Proven provider-specific installation/resume path and capability evidence |
| `packages/cli/src/args.ts`, `run.ts`; dashboard actions/components | Connect-once flow, safe secret input, selection/status/reconnect and private-launch visibility |

Names for new records/modules are proposals. Existing source links in this note
are evidence of seams, not permission to expand unrelated model or golden work.

## Staged delivery and completion evidence

1. **Prove seams first:** one synthetic HTTP, legacy SSE and stdio server under
   both real Boat managed harnesses and Modal drivers. Check tools, resources,
   prompts, multi-repo CWD, reconnect, resume, updates and exact harness versions.
   Resolve Boat configuration/reload and Codex prompt exposure before claiming
   universal compatibility.
2. **Identity/schema:** private launches from shared goldens; connection/grant
   separation; org-admin policies; RLS/service SQL parity. Prove another org member
   cannot use owner grants through exec/send/logs/SSH or a copied binding.
3. **Broker:** discovery and PKCE, CIMD/DCR/pre-registered fixtures, no-refresh and
   refresh rotation races, issuer mismatch, scope step-up, revocation and browser
   callback state replay. Do not create a real third-party grant merely to test
   error handling.
4. **Gateway/runtime:** session/version bridges, method/tool policy, stream and
   cancellation propagation, resource/prompt pagination, typed content and
   per-auth cache isolation; no automatic replay of uncertain mutating calls.
5. **User flow/lifecycle:** connect once and launch either harness/provider,
   live disable/rotation, all-conversation reconciliation, stop/restore with new
   leases, membership removal and secret-free golden/checkpoint inspection.
6. **Actual acceptance matrix:** record versions, transports, auth mechanisms
   and proven operations. Unsupported upstream requirements are actionable
   failures; no stubs or silently missing resources/prompts/SSE. Preserve existing
   model/effort/steer/concurrency behavior and Boat regression coverage.

Outstanding product decisions: which org grants may be shared; default tool
autonomy and optional approval UX; trust policy for custom stdio packages;
private network routing; and whether hosted prompt expansion is acceptable where
a harness has no documented native prompt API. The recommended architecture
keeps these decisions explicit without requiring users to configure each
harness or golden separately.

## Primary sources

[auth]: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
[registration]: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration.md
[security]: https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices
[changes]: https://modelcontextprotocol.io/specification/2026-07-28/changelog
[transports]: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports
[features]: https://modelcontextprotocol.io/specification/2026-07-28/server/tools
[resources]: https://modelcontextprotocol.io/specification/2026-07-28/server/resources
[revocation]: https://www.rfc-editor.org/rfc/rfc7009
[claude-mcp]: https://code.claude.com/docs/en/agent-sdk/mcp
[claude-types]: https://code.claude.com/docs/en/agent-sdk/typescript
[claude-cli]: https://code.claude.com/docs/en/mcp
[codex-mcp]: https://learn.chatgpt.com/docs/extend/mcp?surface=cli
[codex-app]: https://learn.chatgpt.com/docs/app-server
[boat-sdk]: https://registry.npmjs.org/@boatdev/sdk/-/sdk-1.13.0.tgz
