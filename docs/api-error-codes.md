# API error-code catalogue

Audit baseline: 2026-11-10 (#829). Scope: authenticated Armada control API
`/api/v1/` and its shared MCP tools, not OAuth protocol errors, dashboard
PostgREST errors or provider-native exceptions. Sources:
`packages/core/src/api-failure.ts`, `launch-error.ts`, `provider.ts`;
`packages/mcp-server/src/{api-failure,control,tool-api,orchestrator-api}.ts`.

Control errors normally have `{error:{code,message}}`; do not parse the message.
MCP returns `isError` and an `error code: CODE` text marker, not an HTTP error
status. Orchestrator accepted operations use HTTP 202, including receipts that
subsequently fail; inspect the receipt and events, not just HTTP success.
Diagnostic stage/reason labels and preservation reasons are not API error codes.

## Shared typed failures (mapped before legacy class-specific errors)

| Code | HTTP | Client meaning |
| --- | --- | --- |
| credential_refused | 422 | Reconnect/replace the selected credential; do not retry unchanged. |
| provider_unavailable | 502 | Provider unavailable; retry with existing operation identity. |
| dependency_unavailable | 503 | Server/auth/database/encryption dependency unavailable. |
| outcome_unknown | 503 | Inspect existing operation/resource before retry; an effect may already exist. |

Typed provider unauthorized becomes credential_refused; unavailable/unknown
become provider_unavailable. A retained-source/resource receipt takes precedence
and becomes outcome_unknown. Vault unavailable becomes dependency_unavailable.
A LaunchError with a recorded legacy code retains that code (no message guessing).

## Control and shared-tool mappings

| Codes | HTTP | Meaning / action |
| --- | --- | --- |
| invalid, invalid_config | 400 | Correct request/configuration. invalid also covers method rejection at 405. |
| unauthorized | 401 | Authenticate again (control authentication, not provider credential refusal). |
| forbidden | 403 | Caller lacks access. |
| not_found | 404 | Resource not visible or missing. |
| missing_credential | 404 direct VaultError; 400 via shared tool | Account credential missing. |
| conflict, credential_binding_required, credential_binding_unsafe | 409 | Refresh state or explicitly repair credential binding. |
| sandbox_not_ready, no_running_turn | 409 via shared tool; 503 for direct ProviderError | Wait for readiness, or avoid steering an absent turn. |
| invalid_request | 400 | Invalid provider/tool/launch request. |
| no_credentials, start_failed, init_failed, prompt_failed | 400 | Launch refused or recorded failure; inspect existing sandbox before a new launch. |
| setup_failed, snapshot_failed, build_failed | 502 | Golden build/setup failed. |
| provider_not_configured | 503 | Provider adapter/account unavailable. |
| provider_mismatch | 503 direct control; 400 via shared tool | Persisted routing disagrees; do not switch providers. |
| payment_required, rate_limited | 400 via shared tool; 503 for direct ProviderError | Resolve billing/quota or back off; surface-dependent legacy status. |
| unavailable | 503 via legacy shared tool | Legacy unavailable marker; typed paths use the shared categories above. |
| unknown | 502 via shared tool | Legacy unknown marker; typed provider unknown is provider_unavailable. |
| internal | 500 control fallback; 503 via shared tool | Server failure; never infer non-dispatch from this alone. |
| denied, busy, upstream | 403, 409, 502 | Gateway access denied, occupied, or upstream failure. |
| unsafe_endpoint, unsupported, needs_reconnect | 400 | Correct endpoint/capability or reconnect the gateway. |

Vault/Invitation errors use invalid/forbidden/not_found/missing_credential/
conflict/unavailable/credential_refused and credential binding codes. Invitation
errors can additionally carry a closed `reason` and `retryAfterSeconds`.
Golden errors use the explicit golden mappings above. The shared-tool adapter
defaults unrecognized marker codes to 400; this is a fallback, not a new code.

## Auth and token routes under `/api/v1/`

These routes are dispatched before the main control error handler. They use the
control error envelope, but **not** its shared typed-failure precedence. OAuth
protocol endpoints outside this namespace remain outside this catalogue.

| Route / failure | HTTP and code | Client meaning |
| --- | --- | --- |
| `auth/authorize` invalid browser login | 400 invalid | Correct provider, callback and PKCE/state inputs. |
| `auth/email/start` invalid request or other failure | 400 invalid | Correct email login inputs; this catch also masks dependency failures. |
| `auth/email/start` caught error message containing `Too many` | 429 rate_limited | Back off before starting email login again. |
| `auth/email/verify` any caught failure | 401 unauthorized | Email code refused; request/verify a valid code. |
| `auth/exchange`, `auth/refresh`: ProviderRoutingError | 503 provider_not_configured or provider_mismatch | Server routing unavailable; do not switch provider identity. |
| `auth/exchange`, `auth/refresh`: LaunchError | 400, original launch code | Inspect the code; shared failure categories are not remapped here. |
| `auth/exchange`, `auth/refresh`: VaultError | 400, original vault code | Original code survives even for missing_credential, conflict, credential_refused or unavailable. |
| `auth/exchange`, `auth/refresh`: any other caught failure | 401 unauthorized | Login exchange/refresh refused; this can mask a dependency failure. |
| `token/list`: any caught failure | 401 unauthorized | Authenticate again; catch also covers non-auth failures. |
| `token/create`: invalid/conflicting org selectors | 400 invalid or 403 forbidden | Correct selectors and caller scope. |
| `token/create`: any caught failure | 401 unauthorized | Token creation refused. |
| `token/revoke`: scope rejection or any caught failure | 403 forbidden | Revocation refused. |
| All above: unsupported method | 405 invalid | Use GET for auth/authorize, POST for the others. |

The exchange/refresh VaultError catch maps **every** VaultError code to 400,
unlike the main handler's STATUS map (for example missing_credential 404,
conflict 409, credential_refused 422) and its earlier normalization of unavailable
to dependency_unavailable 503. LaunchError is also always 400 here, even when
its code is a shared failure category. ProviderRoutingError remains 503. The
fallback is unauthorized 401 rather than the main handler's internal 500.
These are existing route-specific behaviors, not recommended client semantics.

## Orchestrator routes

Runtime errors expose not_found (404), conflict (409), invalid_request (400),
or a shared failure category above. Runtime unavailable is normalized to
dependency_unavailable; unknown admission becomes outcome_unknown. A syntactically
invalid request becomes invalid_request; unexpected errors become
dependency_unavailable. Error responses may include admission/operation evidence.

Operation `errorCode` (for example runtime_uncertain,
previous_conversation_not_continued, boat_conversation_unavailable) describes
a ledger result, not a separate HTTP status. Read it with state and continuity.
The successful fresh-Boat-conversation note does not mean the resume failed.

## Transport exceptions and known inconsistencies

Unknown non-MCP paths use HTTP 404 `{error:"not_found"}` in `http.ts`;
MCP drain uses 503 `temporarily_unavailable` with Retry-After. OAuth routes retain
OAuth error vocabulary rather than this control envelope.

Direct ProviderError mapping and shared-tool mapping differ for not_found
(direct: 503, tool: 404), sandbox_not_ready/no_running_turn, billing/quota and
internal as listed above. Do not silently change these in a refactor. The audit
follow-up [#833](https://github.com/The-Vibe-Company/armada/issues/833) calls for
table-driven route-contract tests before normalization, including auth email-start
rate_limited 429 versus provider/tool 503/400, exchange/refresh VaultError 400
versus the main handler, and the auth fallback 401 versus control fallback 500.
