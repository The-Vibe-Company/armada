# Remote MCP through the Boat runtime (#1161)

Remote HTTP/SSE MCP uses the **existing** `connections` launch field and
`defaultForLaunch` registry setting. Bindings are frozen at launch; preparation
runs automatically before the first, later and first resumed prompts. There is no
separate user setup/repair option or public `runtime_mcp_refresh` tool/endpoint.
Native Boat and Modal setup/transport remain unchanged while parity is finished.

The runtime receives only gateway capabilities over sealed private commands, not
upstream authentication. The existing registry/gateway still enforce current
membership, personal/org access, grant state and expiry. Lease authority is bound
to the current runtime epoch/lifecycle; checkpoint/session replacement durably
revoke it, including for older gateway replicas. Resume boots with empty MCP
defaults, then automatic preparation reauthorizes its fixed connections before
inference. A stale artifact without MCP-v1 health is refused before configuration.

Preparation and command enqueue commit **together** under the sandbox/epoch fence;
network waits happen afterwards. Concurrent updated grants cannot place an older
snapshot behind a newer one, then hide that stale guest state behind a cached ACK.
Unchanged current configuration reuses its verified receipt without RPC. Ordinary
OAuth access refresh remains gateway-owned; reconnect/definition generation
changes refresh the next turn automatically, and deleted bindings clear the guest
snapshot. Completed turn replays do not reconfigure or start another turn.

The server advertises `boatRuntime.mcpVersion:2` for this automatic lifecycle.
Guest RPC capability remains v1. An older check/server combination fails before
allocation instead of using a compatibility mode. Local pinned **stdio launchers
are not enabled**; unsupported defaults/selections fail before forking. Production
usage must be confirmed by the owner before porting an unused native-only feature.

## ONE coordinator staging check

No new migration in this slice. Its parent #1377's
`20261113074000_runtime_mcp_epochs.sql` must already be applied normally before the
matching server/runtime image. Normal images publish pinned artifacts; **no manual
publication**. Existing Boat opt-in and resume/GitHub prerequisites remain; no
deployment in flight. The owner, not this worker, controls default flips.

From updated main (or the full stacked branch before merge), use the usual
coordinator environment: server HTTPS origin, environment-only Armada bearer,
organization UUID, snapshotted Boat golden, authorized Codex account UUID,
optional model, and an owner-accessible golden GitHub repository with Git/gh.
Select an **existing connected HTTP/SSE MCP connection already marked
`defaultForLaunch` on staging**; the check intentionally omits explicit selection
to prove the normal default workflow, not a separate setup endpoint.

- `ARMADA_RUNTIME_MCP_CONNECTION_ID`: that connection UUID.
- `ARMADA_RUNTIME_MCP_TOOL`: exact read-only tool name, without server prefix;
  prefer a no-argument read tool.
- `ARMADA_RUNTIME_MCP_ARGS_JSON`: exact **non-secret** JSON object, default `{}`.
- `ARMADA_RUNTIME_MCP_EXPECT`: stable non-secret substring of its JSON-rendered
  result; this expectation is **not sent to the model**.

```sh
ARMADA_RUNTIME_SMOKE=one_real_boat_launch \
bun scripts/check-boat-runtime.ts --mcp --github --resume
```

Budget **ONE allocation + ONE same-VM resume activation (two host starts), FOUR
prompts, TWO stops**, no activation/allocation retry. Capabilities, connection
health/default metadata and GitHub repository access preflight before allocation.

1. **First prompt** calls the selected MCP tool, teaches a random token and gives
   a separate exact ACK. This proves configuration preceded the first inference.
2. Follow-up calls MCP again and performs the existing GitHub check, then recalls
   memory without receiving it again. No MCP setup action is sent by the client.
3. Checkpoint/stop; read the receipt and both histories while stopped.
4. Resume the same sandbox/conversation into the next epoch. The **first resumed
   prompt** calls MCP and recalls memory, proving automatic new-epoch setup.
5. Existing explicit GitHub refresh/check in prompt4; MCP still works without a
   setup call. Checkpoint/stop and read ALL FOUR histories and the same receipt.

Require exact answers + finished events from `logs/read.source:"armada-runtime"`;
MCP results must match this prompt's `tools[].server`, exact tool/JSON arguments,
`isError:false` and expected result substring. Check again while stopped; another
server, prior prompt or assistant assertion cannot satisfy it. Checkpoint
watermark must equal acknowledgedSequence. Final JSON includes
`mcpAfterResume:"verified"`, `githubAfterResume:"verified"`, `resume:"verified"`
and safe `mcpProof` naming new epoch/prompt/connection/server/tool. Keep printed
operation UUIDs on uncertainty; inspect/stop, never activate again to guess.

Without `--github`, `--mcp --resume` is a three-prompt lifecycle; `--mcp` alone is
one activation/two prompts and does not prove resume. These are checks of the one
product path, not product behavior switches. Real staging MCP acceptance remains
coordinator-owned; offline SDK/native protocol evidence is not a model/MCP pass.

Cutover gate: [owner parity table](https://github.com/The-Vibe-Company/armada/issues/1161#issuecomment-6848248708).
Only after production-used parity is staging-green does the owner flip staging,
then production. Native deletion is a separate PR after one day in production.
