# #529 integration matrix

This is an integration worktree, **not complete feature parity**. Git index remains coordinator-owned.
All CLI HTTP requests target Armada. Never supply authentication secrets as command arguments.

| Web feature / action | CLI | Shared endpoint (POST /api/v1/) | State |
|---|---|---|---|
| Sandbox list | `list [--org UUID]` | sandbox/list | Shared MCP list operation |
| Sandbox detail / status | `detail ID`, `status ID` | sandbox/detail, sandbox/status | Shared MCP status operation |
| Live agent events | `logs ID --all --follow` | logs/read | Existing; follow carries returned cursor to the next request |
| Send / turn overrides | `send ID PROMPT --model ID --reasoning-effort LEVEL` | sandbox/send | Shared MCP send; stored model fallback |
| Stop | `stop ID` | sandbox/stop | Shared MCP stop |
| Wait | `wait ID --timeout SECONDS --prompt-id ID` | sandbox/wait | Shared MCP wait |
| Shell command | `exec ID -- COMMAND` | sandbox/exec | Shared MCP exec with vault redaction |
| Steer / interrupt | `steer ID TEXT`, `interrupt ID` | sandbox/steer, sandbox/interrupt | Shared MCP operations |
| Launch agent/prompt/repo/model/effort/TTL/org/provider | `launch GOLDEN --agent codex --repo owner/repo --model ID --reasoning-effort medium --ttl 4h --org UUID --provider boat` | sandbox/launch | Server-side routing and resolution |
| Independent privacy / connections | `launch ... --visibility private --connections UUID,UUID` | sandbox/launch | Explicit unavailable pending #520, never silently ignored |
| Golden list/metadata | `golden list --provider boat --json --org UUID` | golden/list | Provider-neutral metadata and scoped list |
| Golden create/update repos/init/setup | `golden create/update NAME --repo URL --init CMD --setup FILE` | golden/create, golden/update | Secure server builder retained; Modal creation unavailable |
| Golden connect/snapshot | `golden connect/snapshot NAME --provider boat` | golden/connect, golden/snapshot | API-only; same-name provider ambiguity refused |
| Golden visibility | `golden visibility UUID --visibility private` | golden/visibility | Uses existing SQL policy function in transaction, not duplicate policy |
| Organizations/members | `org create/list`, `org members list/add/remove/role --org NAME` | org/create,list; members/list,add,remove,role | Existing API commands |
| Selected organization | Explicit `--org` | Request-scoped caller | Persistent `org use` still missing |
| Personal/org credentials | `creds set/list/rm KIND --org NAME --file FILE` | creds/set,list,rm | Write-only values; metadata-only read |
| GitHub status/connect/disconnect/install | **Missing** | **Missing HTTP surface** | Dashboard integration remains to implement |
| Service tokens | `token create/list/revoke` | token/create,list,revoke | Existing scoped auth API |
| Login/logout | `login`, `logout` | auth/authorize,exchange,refresh,email/start,email/verify | Existing Armada-only session flow |
| Account actions beyond login/logout | **Missing** | **Missing** | Inventory and implementation remaining |
| MCP definitions/grants | `mcp list/add/update/connect/status/reconnect/disable/revoke/delete [UUID] --org UUID` | mcp/list,create,update,connect,status,reconnect,disable,revoke,delete | HTTP client present; registry/backend owned by #520; no fabricated success |
| MCP definition/secret input | `mcp add/update --file JSON` or piped JSON | mcp/create,update | Request body only, never argv |
| MCP OAuth browser/poll | connect/status | mcp/connect,status | Authorization URL returned; automatic browser open and polling still missing |
| Local visual settings | No cloud command | None | Theme/layout are local presentation, not cloud state |

## Shared integration contracts

Sandbox HTTP operations invoke the real MCP SDK operation with the authenticated caller's scoped data and provider registry. This keeps schema validation, ownership checks, model fallback, stop bookkeeping, wait semantics and exec redaction in their existing implementation. Missing registry remains an error, not a connected state. #520 must replace the explicit unavailable guard for launch visibility/connections when its authoritative privacy/binding implementation is integrated. Do not remove the guard before that wiring exists.

Canonical MCP prefix is `/api/v1/mcp/`. The registry contract from #520 is list → `{connections}`, create/update/status → `{connection}`, connect → `{connection,authorizationUrl?}`, revoke/delete → `{ok:true}`. Reconnect/disable require coordinator alignment with registry controls. CLI prints real returned metadata; it does not treat a returned authorization URL as successful authorization. Callback remains dashboard `/auth/mcp/callback` → authenticated `/api/v1/mcp/oauth/callback`; no callback codes belong in CLI arguments.

## Outstanding integration risks

- Provider-neutral secure golden persistence is Boat-only; immutable Modal creation requires the actual adapter. No Boat fallback is allowed.
- Golden restore currently uses scoped data whose mutation methods remain read-only: stopped-master connect needs an authorized persistence port before production acceptance.
- Golden visibility SQL errors should be mapped to stable forbidden/conflict API errors rather than generic server errors.
- MCP broker URLs must be validated by the authoritative broker before opening; CLI currently only prints responses.
- SDK error bridge currently maps tool failures to an invalid error; preserve exact structured tool error codes in follow-up.
- CLI global JSON/error output, persistent org selection, account and GitHub parity, additional launch controls and explicit cursor-resume flags need completing.

## Test audit / ownership

- Command parsing and API envelope belong to `packages/cli/test/*-api*.test.ts`; provider runtime rules remain in core/provider tests, not test-only CLI store injections.
- The new `CLI sandbox list shares the MCP scoped operation and rejects unavailable registry features` test in `packages/mcp-server/test/control.test.ts` drives `run` → authenticated HTTP handler → scoped SQL → actual MCP SDK operation. It covers real empty-list success, invisible detail failure and absent MCP registry failure without provider/database networking.
- Existing `provider-routing.test.ts` remains the owner of neutral IDs, Modal pinned binding and no-Boat-fallback behavior. Existing model launch/send tests own stored defaults and overrides.
- Existing golden-create tests own the fail-closed scan, ephemeral SSH checkout and server persistence; updated CLI fixtures use neutral provider fields rather than resurrecting direct Supabase clients.
- Standalone CLI/server bundling and npm installation smoke are separate acceptance checks, not substitutes for deployed conformance.
