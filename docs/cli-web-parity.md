# CLI and dashboard features

The CLI and dashboard use the same Armada authorization and provider contracts. The CLI contacts the Armada API; provider credentials and database access stay on the server.

## Feature matrix

Commands below start with `armada`. Select an organization with `org use NAME|UUID`, or pass `--org` for one request.

| Feature | Dashboard | CLI |
|---|---|---|
| Sign in / local sign out | Sign-in page and logout | `login [--url URL]`, `logout`; email links/codes and enabled social providers |
| Account identity / session invalidation | Signed-in account and logout | `account status`, `account logout` invalidates the current login session, then clears local auth |
| Organizations and members | Organization selection and admin management | `org create/list/use/current`, `org members list/add/remove/role` |
| Personal and org credentials | Write-only model/hosting forms; org writes require admin | `creds list`, `creds set KIND`, `creds remove ACCOUNT_UUID`; legacy `creds rm KIND` only when unambiguous; values from stdin or `--file` |
| Modal credentials | Separate token ID and token-secret fields, stored together | `creds set modal --file /secure/modal-token.json`; canonical JSON uses `token_id` and `token_secret` |
| Service tokens | Token management | `token create/list/revoke`; optional organization scope |
| GitHub connection | Connect, reconnect, disconnect and installation settings | `github status/connect/reconnect/disconnect/install/manage`; browser flow waits for its own completion |
| Snapshot list and identity | Separate Boat/Modal rows under private/shared sections | `snapshot list [--provider boat\|modal] [--json]`; JSON includes safe `id` and `orgId` |
| Snapshot capacity | Per-provider server-reported capacity | `snapshot capabilities [--provider boat\|modal] [--org UUID] [--json]`; null means unknown/unbounded, not zero |
| Build / rebuild snapshots | Provider selection on create; rebuild keeps the stored provider, name and visibility | `snapshot create NAME --repo URL[@BRANCH]`; update with `--add-repo URL` or `--replace --config FILE` (see examples below) |
| Durable build progress | Admission receipt, bounded status polling and recovery after reload | `snapshot build-status JOB_ID`, or `snapshot build-status --idempotency-key KEY --org ORG` |
| Snapshot builds | Build/rebuild workflow | Use `snapshot update` for Boat/Modal or `snapshot rebuild` for Docker |
| Snapshot visibility | Owner/admin visibility controls | `snapshot visibility UUID --visibility private\|org` |
| Launch | Snapshot, agent, model, effort, TTL and MCP connections | `launch PRIVATE_SNAPSHOT --provider boat --agent claude\|codex\|opencode [PROMPT] --model ID --reasoning-effort LEVEL --ttl 4h --connections UUID,UUID`. Ordinary cloud launches inherit snapshot visibility. |
| Repository context | Select a configured repository directory | `launch ... --repo DIR` or `--repo owner/repo`; persisted native cwd, including idle launches |
| Sandbox list | Authorized filters and pages | `list --status STATUS --agent HARNESS --golden UUID --owner UUID\|me --page N --limit N [--json] [--page-info]` |
| Sandbox detail / status | Sandbox page and prompt status | `detail ID`, `status ID`; actual stored privacy and repository context |
| Agent turns | Send, steer and interrupt | `send ID PROMPT`, `steer ID TEXT`, `interrupt ID`; model/effort overrides where supported |
| Stop / wait | Stop and turn progress | `stop ID`, `wait ID --timeout SECONDS [--prompt-id ID]` |
| Events / commands | Event stream and sandbox commands | `logs ID --all --follow [--since CURSOR]`, `exec ID -- COMMAND` |
| MCP definitions | Personal/shared definitions, status and authorization | `mcp list/add/update/connect/status/reconnect/enable/disable/revoke/delete` |
| Public/OAuth MCP shortcut | Connection creation form | `mcp add NAME URL [--scope personal\|org]`; defaults personal, HTTP, automatic auth discovery |
| Existing sandbox bindings | Selected connection metadata | `mcp sandbox-connections SANDBOX_UUID --org UUID`; read-only |
| Theme and layout | Local presentation preferences | No cloud command |

See [sandbox list and JSON output](cli-web-parity-556.md) for filter limits, totals and compatibility shapes.

## Model accounts and limits

Use `armada creds presets --json` to discover named model connections shared with
the dashboard. Morph is a model-account kind, not a compute provider; one account
supports Claude Code, Codex and OpenCode on supported runtime-backed placements.
Select an account explicitly with `--credential-id ACCOUNT_UUID` at launch, or
use the authorized compatible default. Never pass the key in arguments.

Morph defaults to 2 simultaneous agents per account; other kinds default to
unlimited. Capacity spans providers and harnesses; stopped/idle-paused sandboxes
do not count. A busy selected account refuses admission rather than silently
switching billing. Lowering a cap leaves existing running agents alone.

```sh
armada creds connect morph --name shared --file /private/morph-key --max-agents 2
armada creds limits ACCOUNT_UUID --max-agents 2
armada creds limits ACCOUNT_UUID --unlimited
```

These account caps are distinct from snapshot build capacity and Docker host
capacity. See [named model accounts](named-model-credentials.md) and
[Morph](morph.md) for details and runtime restrictions.

## Build and provider behavior

For Boat/Modal, `--repo` or `--config` on update replaces the entire saved
configuration and requires explicit `--replace`. Use `--add-repo` to append
without losing existing repositories and init commands:

```sh
armada snapshot create web --provider modal --repo https://github.com/acme/web.git
armada snapshot update web --provider modal --add-repo https://github.com/acme/api.git
armada snapshot update web --provider modal --replace --config snapshot.json
```

Choose one update mode, not both. Preserve the complete desired configuration
in a replacement file and recover an uncertain prior build before submitting
a new operation. Docker host-local snapshots use their separate
[rebuild command](docker-snapshots.md#updating-an-older-snapshot-1528).



Boat and Modal builds use durable server jobs. Create/update returns an admission receipt; closing the browser or ending the CLI's polling does not cancel the job. The CLI polls for up to `--timeout` seconds (default 60, maximum 600); `--timeout 0` returns after admission. Keep the job ID and admission key to recover an uncertain answer instead of starting another build. The dashboard records each form's job/key separately by organization or snapshot ID.

A snapshot's provider is immutable. Same-name Boat and Modal snapshots are distinct; an ambiguous CLI selection requires `--provider`. Rebuild reads the stored target and preserves ownership/visibility. Unconfigured providers fail explicitly; Modal never falls back to Boat. A reported capacity is metadata, not a guarantee that a build will be admitted.

Repository context is a real native working directory, persisted per sandbox. It is not filesystem confinement. It cannot be changed by later send/steer operations or by editing the source snapshot. See [repository context](repository-context.md).

MCP connections are prepared before a new agent turn, including after sandbox resume. Restored sandboxes receive fresh access while retaining the conversation. See the [MCP lifecycle](mcp-bootstrap.md) for native configuration, concurrent resume and revocation behavior.

## Scope and secret handling

- Organization selection is saved per Armada server origin. Explicit `--org` wins. Personal credential set/remove remains personal unless `--org` is supplied.
- Membership, private ownership and org-admin rules are enforced by the server/database for both interfaces. A private launch from an org snapshot reports private sandbox visibility while retaining the source snapshot's provider credential scope.
- Credentials are write-only: list/status shows kinds, dates and presence, never values. Model credentials run agents; Boat/Modal hosting credentials stay on the Armada server. The CLI also accepts structured `codex-auth` from stdin/file.
- Put credential values, MCP bearer tokens and headers in stdin or a protected file, never command arguments or URL query parameters. The MCP NAME/URL shortcut rejects secret-bearing URLs and mixed file/stdin definitions.
- GitHub and MCP authorization use validated browser handoffs and authenticated status polling. `--no-browser` prints a handoff for manual use; timeout is not reported as success. GitHub uses the registered dashboard `/github/callback`; MCP uses `/auth/mcp/callback`. Callback codes are not CLI arguments.
- GitHub disconnect removes Armada's stored grant. Revoke already-issued access in GitHub settings when needed. Neither interface offers account deletion or profile editing here.
