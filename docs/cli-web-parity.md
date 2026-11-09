# CLI and dashboard features

The CLI and dashboard use the same Armada authorization and provider contracts. The CLI contacts the Armada API; provider credentials and database access stay on the server.

## Feature matrix

Commands below start with `armada`. Select an organization with `org use NAME|UUID`, or pass `--org` for one request.

| Feature | Dashboard | CLI |
|---|---|---|
| Sign in / local sign out | Sign-in page and logout | `login [--url URL]`, `logout`; email links/codes and enabled social providers |
| Account identity / session invalidation | Signed-in account and logout | `account status`, `account logout` invalidates the current login session, then clears local auth |
| Organizations and members | Organization selection and admin management | `org create/list/use/current`, `org members list/add/remove/role` |
| Personal and org credentials | Write-only model/hosting forms; org writes require admin | `creds set/list/rm KIND [--org NAME]`; values from stdin or `--file` |
| Modal credentials | Separate token ID and token-secret fields, stored together | `creds set modal --file /secure/modal-token.json`; canonical JSON uses `token_id` and `token_secret` |
| Service tokens | Token management | `token create/list/revoke`; optional organization scope |
| GitHub connection | Connect, reconnect, disconnect and installation settings | `github status/connect/reconnect/disconnect/install/manage`; browser flow waits for its own completion |
| Golden list and identity | Separate Boat/Modal rows under private/shared sections | `golden list [--provider boat|modal] [--json]`; JSON includes safe `id` and `orgId` |
| Golden capacity | Per-provider server-reported capacity | `golden capabilities [--provider boat|modal] [--org UUID] [--json]`; null means unknown/unbounded, not zero |
| Build / rebuild goldens | Provider selection on create; rebuild keeps the stored provider, name and visibility | `golden create/update NAME --repo URL[@BRANCH] --init CMD --setup FILE [--provider boat|modal]` |
| Durable build progress | Admission receipt, bounded status polling and recovery after reload | `golden build-status JOB_ID`, or `golden build-status --idempotency-key KEY --org ORG` |
| Manual golden maintenance | Build/rebuild workflow | Additional CLI commands: `golden connect NAME`, `golden snapshot NAME`; select `--provider` for same-name goldens |
| Golden visibility | Owner/admin visibility controls | `golden visibility UUID --visibility private|org` |
| Launch | Golden, harness, model, effort, TTL, privacy and MCP connections | `launch GOLDEN --agent claude|codex [PROMPT] --model ID --reasoning-effort LEVEL --ttl 4h --visibility private --connections UUID,UUID` |
| Repository context | Select a configured repository directory | `launch ... --repo DIR` or `--repo owner/repo`; persisted native cwd, including idle launches |
| Sandbox list | Authorized filters and pages | `list --status STATUS --agent HARNESS --golden UUID --owner UUID|me --page N --limit N [--json] [--page-info]` |
| Sandbox detail / status | Sandbox page and prompt status | `detail ID`, `status ID`; actual stored privacy and repository context |
| Agent turns | Send, steer and interrupt | `send ID PROMPT`, `steer ID TEXT`, `interrupt ID`; model/effort overrides where supported |
| Stop / wait | Stop and turn progress | `stop ID`, `wait ID --timeout SECONDS [--prompt-id ID]` |
| Events / commands | Event stream and sandbox commands | `logs ID --all --follow [--since CURSOR]`, `exec ID -- COMMAND` |
| MCP definitions | Personal/shared definitions, status and authorization | `mcp list/add/update/connect/status/reconnect/enable/disable/revoke/delete` |
| Public/OAuth MCP shortcut | Connection creation form | `mcp add NAME URL [--scope personal|org]`; defaults personal, HTTP, automatic auth discovery |
| Existing sandbox bindings | Selected connection metadata | `mcp sandbox-connections SANDBOX_UUID --org UUID`; read-only |
| Theme and layout | Local presentation preferences | No cloud command |

See [sandbox list and JSON output](cli-web-parity-556.md) for filter limits, totals and compatibility shapes.

## Build and provider behavior

Boat and Modal builds use durable server jobs. Create/update returns an admission receipt; closing the browser or ending the CLI's polling does not cancel the job. The CLI polls for up to `--timeout` seconds (default 60, maximum 600); `--timeout 0` returns after admission. Keep the job ID and admission key to recover an uncertain answer instead of starting another build. The dashboard records each form's job/key separately by organization or golden ID.

A golden's provider is immutable. Same-name Boat and Modal goldens are distinct; an ambiguous CLI selection requires `--provider`. Rebuild reads the stored target and preserves ownership/visibility. Unconfigured providers fail explicitly; Modal never falls back to Boat. A reported capacity is metadata, not a guarantee that a build will be admitted.

Repository context is a real native working directory, persisted per sandbox. It is not filesystem confinement. It cannot be changed by later send/steer operations or by editing the source golden. See [repository context](repository-context.md).

MCP connections are prepared before a new agent turn, including after sandbox resume. Restored sandboxes receive fresh access while retaining the conversation. See the [MCP lifecycle](mcp-bootstrap.md) for native configuration, concurrent resume and revocation behavior.

## Scope and secret handling

- Organization selection is saved per Armada server origin. Explicit `--org` wins. Personal credential set/remove remains personal unless `--org` is supplied.
- Membership, private ownership and org-admin rules are enforced by the server/database for both interfaces. A private launch from an org golden reports private sandbox visibility while retaining the source golden's provider credential scope.
- Credentials are write-only: list/status shows kinds, dates and presence, never values. Model credentials run agents; Boat/Modal hosting credentials stay on the Armada server. The CLI also accepts structured `codex-auth` from stdin/file.
- Put credential values, MCP bearer tokens and headers in stdin or a protected file, never command arguments or URL query parameters. The MCP NAME/URL shortcut rejects secret-bearing URLs and mixed file/stdin definitions.
- GitHub and MCP authorization use validated browser handoffs and authenticated status polling. `--no-browser` prints a handoff for manual use; timeout is not reported as success. GitHub uses the registered dashboard `/github/callback`; MCP uses `/auth/mcp/callback`. Callback codes are not CLI arguments.
- GitHub disconnect removes Armada's stored grant. Revoke already-issued access in GitHub settings when needed. Neither interface offers account deletion or profile editing here.
