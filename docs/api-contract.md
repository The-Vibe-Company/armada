# Armada API operation table

Design for Step 2b of #2835. This note defines the contract for #2772–#2777 and
the client cutover. The route inventory is based on `15b019e7`, after #2714
and #2716.

## One operation, one contract

The browser-safe `@armada/core/contract` subpath owns declarative metadata and
Zod schemas. Each entry has this shape:

```ts
{
  name,         // Stable operation ID, also the default OpenAPI operationId
  route,        // HTTP method plus /api/v1 path template
  input,        // Zod schemas for path, query, headers and/or body as applicable
  output,       // Success schema and status/media type (including streams)
  readOnly,     // No domain mutation
  destructive,  // May remove resources, revoke access or interrupt work
  audience,     // "public" | "agent" | "admin"
  description,
  errors,       // Declared codes from the contract error registry
}
```

`public` means REST-only integration or sign-in, `agent` means REST plus MCP,
and `admin` means dashboard administration. Audience sets exposure, while
handlers still enforce caller authentication, org and resource visibility,
roles, ownership and grants. Keep route-specific rules, including personal-only
sessions, bearer kinds and replay scope. The table contains no credentials,
provider SDKs, SQL, environment I/O or handlers. The server binds each name to
a handler, parses transport input once and keeps authorization and business
validation in the service. Validate uniqueness of names and method/path pairs. Preserve the separation
between direct-server mounts and dashboard forwarding.
Transport bindings decode path and query values and keep the existing body
limits. Streaming outputs describe their media type and event/item schema.

#2775 generates OpenAPI from the table, including the REST surface for
`agent` entries. Publish administrative schemas separately from the public
integration description. #2776 exposes the agent set only, from #2716's tool
inventory. Agent tool names, descriptions and permitted dispatch branches are metadata
on those entries. The primary projection is `launch`, `launch_options`,
`list`, `status`, `send`, `stop`, `logs` (events), `report`, `exec`,
`outputs_list` and `output_read`, matching the agent set in #2716.
Within those tools, status with a wait option calls `waitSandbox`, send
with steering calls `steerSandbox`, and stop with turn scope calls
`interruptSandbox`. Those operations gain no standalone tool registrations.
Stop-after stays within the stop operation. All branches invoke the selected
operation's schema and handler in process. The scoped gateway applies its grant and
sandbox checks before invocation and keeps its separate principal and
transport. An owner operation never acquires delegated authority through an
audience flag.

## Launch input and result

#2772 defines one strict union discriminated on required `provider`, with
`boat`, `modal` and `docker` branches. All require the wire field `harness`
(the CLI's `--agent`) and accept optional `org` as slug or UUID. Resolve org and
check harness support in admission. Callers choose the provider from launch
discovery before submitting. Share the common fields for prompt, model,
reasoning effort, TTL, credential, connections, skills, visibility and work
policy wherever supported. Docker also accepts versioned variable and secret
bindings. An omitted prompt requests an idle launch. Apply size
(`size`) and scoped access (`armadaAccess`) only on eligible branches and
validate capability and policy before side effects.

| Provider | Source and paths | Provider-specific validation |
| --- | --- | --- |
| Boat | Named golden, default or explicit runtime | Carry applicable Boat path selectors until the native retirement tickets remove them. |
| Modal | Named golden, default or explicit runtime, or pinned Modal template revision on the existing explicit runtime path | Keep source forms mutually exclusive. Template revision and account binding stay pinned. |
| Docker | Chosen host with optional repos, or snapshot with optional matching host | Private visibility. Reject mixed source fields, unsupported sizes and scoped access. |

A provider branch can have a strict source union inside it. #2772 preserves
existing path controls until their owning cutovers. Validate shared fields
in the contract and keep model/account policy, source resolution and org
authorization in admission. Docker REST and admission use the shared request
schema, and the standalone Docker schema has been deleted. Pinned Modal REST
launch also uses the shared schema and resolves the org to a UUID before
template admission. MCP `launch` projects the ordinary Boat and Modal golden variants, excluding scoped
Armada access, and publishes their camel-case fields. Golden REST admission
consumes the parsed request from `launch-request-schema.ts`. The remaining
REST cutover moves that request and its OpenAPI variants to the shared operation.
The separate `templates/launch` endpoint keeps its `requestKey` and durable
receipt, and shares applicable field schemas.

#2773 standardizes `{ sandbox, golden, promptId, conversationId, ttlSeconds,
expiresAt, github, helper, runtime }` across REST, SDK, CLI JSON and the MCP
projection when it moves in #2776. The sandbox has an Armada `id`, `provider`,
`status` and optional `externalRef`; provider identifiers and runtime metadata
are present only when available and safe to expose. `golden` is null for
Docker. Null prompt/conversation IDs cover an idle or still-admitting launch;
nullable expiry, helper and runtime fields represent absent values.
For a pinned Modal launch on `sandbox/launch`, #2773 maps an admitted pending
or successful template receipt to the same envelope using the reserved sandbox
ID and available metadata. A refusal or terminal failure maps to a typed
error. An ambiguous allocation returns `outcome_unknown` and carries a
safe reference for replay or inspection. #2760–#2762 own the move to launch
jobs and their `starting` semantics. Callers check the returned state for
readiness.

Accept `idempotencyKey` and `externalRef` for every provider. Scope replay by
caller, org and operation, bind the key to the admitted input and return the
original sandbox for a matching retry. Reuse with different inputs is a
conflict. Use `externalRef` for correlation. In #2773, delete Docker
`requestId` and the pinned Modal wire field `requestKey` from
`sandbox/launch`. For the pinned Modal branch, derive a bounded, namespaced
internal template key from `idempotencyKey` and keep the template's durable
receipt and input binding. Require a replay key on branches that require a
durable identity at admission, including Docker and pinned Modal. After durable admission,
a lost reply is recovered by retrying the same key. During ambiguous
allocation, reconcile the recorded operation before another create.
The contract holds no lease and adds no durable writes. Provider claimants,
queue ownership and crash recovery stay with the lifecycle tickets.

## Errors and clients

Define one typed error registry in the contract. Each code declares its default HTTP
status and client meaning. Declare operation or boundary overrides where needed,
such as `invalid` for HTTP 405 or 413. Use it to generate the OpenAPI error enum and the
API error-code reference, and derive the SDK's error-code union from it.
Use `{ error: { code, message, details? } }` on REST and preserve the same
machine-readable code in MCP's error result. Schema failures use code
`invalid` in both transports. REST returns HTTP 400, and MCP returns a tool
error with that code. Seed the registry from the existing
[API error-code catalogue](api-error-codes.md) and audit route-specific
errors during migration, including viewer, webhooks and the proxy.
Keep typed distinctions such as `credential_refused`, `provider_unavailable`,
`dependency_unavailable` and `outcome_unknown`. Keep credential values and
provider internals out of public messages and details.

#2777 derives SDK request and response types with `z.infer` from the
contract schemas, using schema input types where defaults differ from parsed
values. `scripts/npm.ts` bundles the SDK and ships its declarations without
requiring consumers to install the monorepo or separate runtime dependencies.
OpenAPI serves documentation and non-TypeScript integrations. #2778 adds
SDK methods, #2779–#2783 move CLI commands to the SDK, #2784 provides
`armada api`, #2785 removes dedicated CLI admin commands (D7), and #2786 deletes
the hand-written client. iOS stays hand-written (D5).

## Route inventory and cutover

Paths below are relative to `/api/v1/`. A path group such as
`token/{list,create,revoke}` enumerates literal paths. Single placeholders
like `{id}` are parameters. Every retained method/path gets a separate entry
whose ID is the name shown or, where no name is shown, the method plus
the expanded path with words joined in lower camel case (for example
`postTokenList`). Admin entries can still serve personal account management
and invite flows with their existing authority rules. Keep retained paths and
methods. Delete replaced paths outright under NC, after moving in-repo callers
in the same cutover. The N/N-1 exceptions for database objects, runtime protocol
and Docker host daemon protocol retain their own rollout rules.

| Method | Current path | Target entry or disposition | Ticket |
| --- | --- | --- | --- |
| POST | `sandbox/launch` | `launch` (agent) | #2772 input, #2773 output |
| POST | `launch/options` | `launchOptions` (agent) | #2774 |
| POST | `sandbox/list` | `listSandboxes` (agent) | #2774 |
| POST | `sandbox/status` | `sandboxStatus` (agent) | #2774 |
| POST | `sandbox/send` | `sendPrompt` (agent) | #2774 |
| POST | `sandbox/stop` | `stopSandbox` (agent) | #2774 |
| POST | `sandbox/report` | `reportSandbox` (agent) | #2774 |
| POST | `sandbox/exec` | `execSandbox` (agent) | #2774 |
| POST | `logs/read` | `readLogs` (agent) | #2774 |
| POST | `sandbox/wait` | `waitSandbox` (public) | #2774 |
| POST | `sandbox/steer` | `steerSandbox` (public) | #2774 |
| POST | `sandbox/interrupt` | `interruptSandbox` (public) | #2774 |
| POST | `sandbox/extend` | `extendSandbox` (public) | #2774 |
| POST | `sandbox/resume` | `resumeSandbox` (public) | #2774 |
| POST | `sandbox/recovery` | `recoverSandbox` (public) | #2774 |
| POST | `sandbox/advice` | `sandboxAdvice` (public) | #2774 |
| POST | `sandbox/bind-credential` | `bindSandboxCredential` (admin) | #2774 |
| POST | `sandbox/test-model-connection` | `testSandboxModelConnection` (admin) | #2774 |
| POST | `sandbox/viewer-token` | `createSandboxViewerToken` (public) | #2774 |
| POST | `sandbox/detail` | Delete alias after callers move to `sandbox/status` | #2774 |
| POST | `sandbox/delete` | Delete alias after callers move to `deleteSandbox` | #2774 |
| DELETE | `sandboxes/{id}` | `deleteSandbox` (public); accept optional `requestId` query for Docker replay, preserving the former POST request identity | #2774 |
| GET | `sandboxes/{id}/outputs` | `listSandboxOutputs` (agent) | #2774 |
| GET | `sandboxes/{id}/outputs/{name}` | `readSandboxOutput` (agent); preserve byte ranges | #2774 |
| POST | `viewer/{logs,status,send}` | Public entries with viewer-grant authority | #2774 |
| GET | `viewer/events` | `streamViewerEvents` (public); viewer-grant SSE | #2774 |
| POST | `sandbox/{checkpoint-runtime-v1,resume-runtime-v1,mcp-preflight-v1,github-preflight-v1}` | Public entries for direct-server runtime proof calls; keep off the dashboard proxy | #2774 |
| GET | `auth/{methods,authorize}` | Public sign-in entries | #2775 |
| POST | `auth/{exchange,email/start,email/verify,refresh}` | Public sign-in entries | #2775 |
| GET, POST | `github/oauth/callback` | Two public callback entries | #2775 |
| POST | `github/{refresh,runtime-status}` | Public entries | #2775 |
| POST | `templates/launch` | `launchTemplate` (public) | #2775 |
| POST | `golden/{list,capabilities,adopt}` | Public entries | #2775 |
| POST | `launch/resolve` | Delete retired refusal stub | #2775 |
| POST | `account/{logout,status}` | Admin entries | #2775 |
| POST | `creds/{accounts/auth-capabilities,accounts/default,accounts/limits,accounts/models,accounts/remove,accounts/rename,accounts/set,accounts/usage,defaults/set,list,rm,set}` | Admin entries | #2775 |
| POST | `docker/{hosts/limits,hosts/list,hosts/register-token,hosts/retention,hosts/revoke,snapshots/create,snapshots/get,snapshots/list,snapshots/rebuild}` | Admin entries | #2775 |
| POST | `github/{connect,disconnect,install,reconnect,status}` | Admin entries | #2775 |
| POST | `golden/{build/cancel,build/find,build/status,connect,create,remove,retirement/dry-run,retirement/reconcile,size-policy,snapshot,update,update-add-repos,visibility}` | Admin entries | #2775 |
| POST | `mcp/{catalog,connect,create,delete,list,metadata,oauth/callback,revoke,sandbox-connections,set-enabled,status,update}` | Admin entries | #2775 |
| POST | `members/{add,list,remove,role}` | Admin entries | #2775 |
| POST | `org/{create,invitations/accept,invitations/create,invitations/list,invitations/preview,invitations/resend,invitations/revoke,list,provider/connect,provider/disconnect,provider/status}` | Admin entries | #2775 |
| POST | `routines/{create,delete,enable,get,history,list,pause,preview,update}` | Admin entries | #2775 |
| POST | `secrets/{commit,delete,list,revoke,rotate,set,upload}` | Admin entries | #2775 |
| POST | `skillpack/{catalog,connection,versions}` | Admin entries | #2775 |
| POST | `skills/{defaults/get,defaults/set}` | Admin entries | #2775 |
| POST | `templates/{create,delete,get,list,publish}` | Admin entries | #2775 |
| POST | `token/{create,list,revoke}` | Admin entries | #2775 |
| POST | `variables/{delete,list,read,revoke,set,update}` | Admin entries | #2775 |
| POST | `mcp/reconnect` | Admin entry (direct server) | #2775 |
| GET | `orgs/{id}/langfuse` | `readLangfuseSettings` (admin); preserve member-visible summary | #2775 |
| PUT | `orgs/{id}/langfuse` | `updateLangfuseSettings` (admin); org admin required | #2775 |
| DELETE | `orgs/{id}/langfuse` | `deleteLangfuseSettings` (admin); org admin required | #2775 |
| POST | `orgs/{id}/langfuse/test` | `testLangfuseConnection` (admin); org admin required | #2775 |
| GET | `webhooks` | `listWebhooks` (admin) | #2775 |
| POST | `webhooks` | `createWebhook` (admin) | #2775 |
| GET | `webhooks/deliveries` | `listWebhookDeliveries` (admin) | #2775 |
| DELETE | `webhooks/{id}` | `deleteWebhook` (admin) | #2775 |
| POST | `docker/sandboxes/{launch,get,bootstrap,ready,journal,stop,delete,job}` | Admin preview entries; preserve host enablement and bearer restrictions | #2775 |
| POST | `orchestrator-tools/{finish,launch,read,message,stop,extend}` | Scoped public REST entries; epoch/finish grant required | #2775 |
| POST | `orchestrator-tools/mcp` | Scoped MCP transport; retain mount and apply table-based filtering | #2776 |

`orchestrator-tools/{wait_record,wait_renew,wait_complete}` are unsupported
operations under D5. The bare `orchestrator-tools` path hosts no operation.
The four versioned launch aliases were already removed by #2714.

The inventory uses `public-control-routes.ts`, the dashboard
`control-proxy.ts`, `public-rest-routes.ts`, `control.ts`,
`control-tool-routes.ts` and the direct mounts in `serve.ts` as inputs.
The MCP transport, OAuth protocol endpoints outside `/api/v1/`, health,
artifact distribution, private runtime and Docker host daemon protocols, and
dashboard-only endpoints outside `/api/v1/` are outside this REST contract.
This ticket changes documentation only.
