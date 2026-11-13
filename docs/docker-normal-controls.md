# Docker normal read and cleanup contract (#1165 / #1380)

This increment connects existing Docker resources to the ordinary sandbox control
API **and MCP tools**, rather than another dashboard-only transport. The private
preview remains compatible. No normal Docker launch, normal send, resume, golden,
GitHub/MCP setup, new pricing quotes or visual dashboard changes are enabled here.
Normal status exposes existing native token counts; missing cost remains unknown.

## Shared producer/client vocabulary

The browser-safe core entrypoint exports SANDBOX_PLACEMENT_PROVIDERS,
SANDBOX_PLACEMENT_LABELS, isSandboxPlacementProvider and SandboxPlacementProviderId.
The label catalog is exhaustive over the generated database provider enum. Adding
a producer value requires updating this shared catalog in the same PR. List DTOs,
MCP output validation, dashboard parser/filter and CLI formatter use it; there is
no separate dashboard-widened provider list. Golden-source identity stays narrower
(Boat/Modal): accepting a Docker row must not manufacture a Docker golden.
A real SQL row is tested through normal list/MCP output validation and the actual
dashboard parser and CLI formatter. Swift's existing DTO keeps provider strings
and ignores the golden field in detail; it does not reject this new row value.

## Routes and authority

With ARMADA_DOCKER_HOSTS=1, current owner/admin interior authorization:

- POST /api/v1/sandbox/status or /sandbox/detail {id,org?,prompt_id?}; MCP status.
  The normal envelope adds provider=docker, hostId, image and golden=null. Status
  remains the persisted logical machine state; prompt/settled describe acknowledged
  native turn evidence. No live host/model request is made. A newer unknown or
  admitted turn cannot be hidden by an older finished event; busy refusals do not
  make a conversation permanently unsettled. Unknown/truncated evidence is not
  presented as settled. Retained archive reads survive stop/delete or host revoke.
- POST /api/v1/logs/read keeps its normal cursor, direction, limit, maxBytes,
  coalesce, conversationId/all/follow contract. MCP logs uses since_cursor and
  conversation_id. Both reuse the existing archived-history paging and ar1 cursors,
  filter private model diagnostics after raw paging, and preserve forward progress
  through empty filtered pages. The shared SQL ordering is qualified numeric
  sequence order, not lexicographic ordering of its text output alias.
- POST /api/v1/sandbox/stop and /sandbox/delete {id,org?,request_id?}; MCP stop/delete.
  DELETE /api/v1/sandboxes/:id?org=... is the same normal delete path. No completed
  result precedes a genuine bound host ACK. Waiting releases SQL locks and has a
  45-second budget; timeout is pending/conflict, never fictional completion.
  Unknown pending intent is reused on retry, not duplicated. An explicit failed
  request_id stays failed; a new ordinary request can retry a known cleanup failure
  safely against the same owned machine. Current host/issuer fences still apply to
  new cleanup after revocation. Already-confirmed terminal results stay idempotent.

Production API and MCP share one controller. Boat/Modal routing and default Boat
archive authorization are unchanged. No credential is resolved for read/cleanup;
no worker receives host or model credentials. No migration or new package.

## Truthful discovery

launch/options adds status and logs capability names. Docker status/logs/stop/delete
are true only while their normal controller is installed and host support enabled.
Normal launch remains false until the normal API/CLI launch handler ships, even
if private preview placement is enabled. Normal followupPrompts and resume remain
false. Unsupported fields retain server-written short reasons. The frontend can
replace its read-only Docker placeholder with the existing conversation reader
and these cleanup actions, while keeping unsupported controls disabled.

## Exact coordinator check on the same host

After deploying this revision with the existing explicit Docker flags/x64 manifest,
use the same SSH configuration, staging org and current model-account pin as the
passed check. The host daemon was stopped between checks; --start-host restarts it
without deleting a live/stale lock. No new registration is made.

```sh
set -euo pipefail
export DOCKER_SSH='YOUR_EXISTING_SSH_CONFIG_NAME'
export ARMADA_STAGING='https://armada-mcp-staging.up.railway.app'
export ARMADA_ORG='YOUR_STAGING_ORG_UUID'
export ARMADA_CREDENTIAL='YOUR_CODEX_ACCOUNT_UUID'
export ARMADA_CREDENTIAL_VERSION='1' # current pin
export DOCKER_IMAGE='buildpack-deps@sha256:58021c2a0204361b62a23d2e0244d144d74c29af2d678e2a1f7e6611885d6949'
read -r -s -p 'Staging Armada bearer: ' ARMADA_TOKEN; printf '\n'
export ARMADA_TOKEN
python3 scripts/smoke-docker-lifecycle.py \
  --server "$ARMADA_STAGING" --org "$ARMADA_ORG" \
  --credential "$ARMADA_CREDENTIAL" --credential-version "$ARMADA_CREDENTIAL_VERSION" \
  --ssh "$DOCKER_SSH" --image "$DOCKER_IMAGE" \
  --host-id 70bde9cd-36c9-40af-b15e-65b2f9d3c2a2 --start-host --normal-controls
unset ARMADA_TOKEN
```

Use the already-updated #1405 host binary and retained private state. Initial
allocation/bootstrap/prompt still use the compatible preview in this check;
**all conversation status/logs and stop/delete then use ordinary sandbox routes**.
Expect DOCKER_OK with reported token counts and
`PASS: normal Docker status/logs and stop/delete routes confirmed.` Native IDs,
not model secrets, are printed. Confirm this sandbox appears in normal list and
its row is not skipped; container/volume inventory returns to baseline. Host and
daemon are retained and may be stopped again. No real-host verification is claimed
by local fake-clock/fake-host tests; the coordinator owns that acceptance.
