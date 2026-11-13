# Remote MCP on enrolled Boat/Codex runtimes (#1161)

This slice delivers **existing HTTP/SSE connections through Armada's gateway**
using the private durable runtime command bridge. No provider lookup, native Boat
agent API, boot-id exec, SSH installer or upstream grant crosses this boundary.
Native Boat and Modal setup/transport are unchanged. Shared Codex tool events gain
optional non-secret `tools[].server` provenance; shared MCP redaction also covers
a Bearer token without its header prefix.

## Explicit setup

After the ordinary opt-in runtime launch is running, the owner calls MCP tool
`runtime_mcp_refresh` or:

```text
POST /api/v1/sandbox/configure-mcp-runtime-v1
{"id":"<sandbox UUID>","connections":["<connected MCP UUID>"]}
```

Select 1–32 connected remote connection IDs from the existing registry. Current
membership, org/personal visibility and sandbox ownership apply. This does not
change launch defaults or permit arbitrary URLs/headers. Existing bindings must
match the selection; this endpoint does not edit an established binding set.
Local pinned **stdio MCP is not enabled by this slice**; its runtime-owned launcher
installation remains separate work, not a native-provider fallback.

The runtime receives only gateway capabilities through sealed durable commands,
not upstream credentials. The safe response names `runtime.kind:"armada"`, epoch,
revision, connection IDs and generated MCP server names. Runner passes the private
snapshot to Codex over JSONL for subsequent turns. Repeating identical input can
reconcile delivery after a server restart without minting a second configuration.

Configuration is fixed within an epoch. Definition/grant-generation changes
require checkpoint/stop/resume and explicit refresh in the new epoch; ordinary
server-owned OAuth access-token refresh does not change that configuration.
Disable/disconnect/membership revocation still take effect immediately. Checkpoint
intent and epoch/session replacement durably revoke leases, including for older
rolling-deploy gateway replicas. New validators additionally require the matching
live runtime epoch/lifecycle, no stop request and no checkpoint intent. Expected-
epoch admission prevents a stale prepared configuration entering a new epoch's
command queue. Resume boots with empty MCP defaults, then requires explicit setup;
old native thread configuration cannot silently regain authority.

## Coordinator's ONE combined staging check

Apply new migration `20261113074000_runtime_mcp_epochs.sql` through normal delivery
before deploying the matching server/runtime image. The updated compiled runtime
is needed for MCP server provenance in journal events. Existing experimental Boat
runtime/manifest settings and merged resume/GitHub prerequisites remain. Normal
images publish the pinned artifacts; **no manual publication**. No deployment in
flight while checking.

Use the existing coordinator environment: `ARMADA_URL` = **server HTTPS origin**,
`ARMADA_TOKEN` environment-only, `ARMADA_RUNTIME_ORG` = org UUID,
`ARMADA_RUNTIME_GOLDEN` = snapshotted Boat golden, `ARMADA_RUNTIME_CREDENTIAL_ID` =
authorized Codex account UUID; optional model. Additionally choose one connected,
owner-accessible remote MCP connection and a real **read-only** tool on it:

- `ARMADA_RUNTIME_MCP_CONNECTION_ID`: connection UUID.
- `ARMADA_RUNTIME_MCP_TOOL`: exact tool name, without the MCP server prefix.
- `ARMADA_RUNTIME_MCP_ARGS_JSON`: exact **non-secret** JSON object of arguments;
  defaults to `{}`. Do not supply credentials or write/mutation arguments.
- `ARMADA_RUNTIME_MCP_EXPECT`: stable non-secret substring of its JSON-rendered
  result. This expectation is **not sent to the model**.
- `ARMADA_RUNTIME_GITHUB_REPOSITORY`: repository already in the golden and in the
  connected GitHub owner's scope; golden has Git and gh.

```sh
ARMADA_RUNTIME_SMOKE=one_real_boat_launch \
bun scripts/check-boat-runtime.ts --mcp --github --resume
```

**ONE fresh allocation + ONE same-VM resume activation (two host starts, not one
plan quota charge), FOUR prompts, TWO stops.** No allocation/activation retry.
Before allocation, check all server capability versions, MCP registry/connection
health and GitHub repository access. Missing inputs/capability fail with zero starts.

1. Teach a random token, require a separate exact ACK from the runtime archive.
2. Configure MCP and GitHub in epoch1; same-conversation prompt performs both
   requested read-only operations, then recalls memory without receiving it again.
3. Checkpoint/stop; re-read the receipt and both histories while stopped.
4. Resume the same VM/conversation into epoch2; third prompt proves retained memory.
5. Explicitly configure new-epoch MCP and GitHub (different revisions). Fourth
   prompt performs both operations and recalls memory again. The MCP proof needs
   THIS prompt's successful tool result from the selected `server`, exact tool and
   exact JSON arguments, containing the expected result substring. An old tool
   result, another server or a final assistant assertion cannot satisfy it.
6. Checkpoint/stop again; re-read the receipt and ALL FOUR histories while stopped.

Require exact answers + finished events from `logs/read.source:"armada-runtime"`;
complete checkpoint receipts with watermark=acknowledgedSequence; final JSON
`resume:"verified"`, `githubAfterResume:"verified"`, **`mcpAfterResume:"verified"`**
and `mcpProof` naming the new epoch/revision/fourth prompt/connection/server/tool.
Retain printed operation UUIDs on uncertainty; inspect/stop, never activate again
to guess. Existing `--mcp` alone is a one-activation/two-prompt live-MCP check, but
does not prove resume parity. The worker's offline SDK/native tests are not a real
staging/model/MCP acceptance claim.
