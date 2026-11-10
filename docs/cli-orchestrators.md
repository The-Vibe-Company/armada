# Persistent orchestrators from the CLI

`armada orchestrator --help` lists the commands without requiring login. Other
commands use the existing Armada login or `ARMADA_TOKEN`, never provider or
database credentials. Use opaque organization, golden and model-account IDs.

```sh
armada orchestrator capabilities --json
armada orchestrator create reviews --org ORG --golden GOLDEN --provider boat \
  --agent claude --model MODEL --model-account ACCOUNT --repo web \
  --size medium --idle-seconds 7200 --idempotency-key CREATE_KEY --json
armada orchestrator list --org ORG --json
armada orchestrator detail ID --org ORG --json
armada orchestrator send ID 'Review the next issue' --org ORG \
  --expected-revision 7 --idempotency-key MESSAGE_KEY --json
armada orchestrator steer ID 'Focus on the failing check' --org ORG \
  --expected-revision 8 --idempotency-key STEER_KEY --json
armada orchestrator stop ID --org ORG --expected-revision 9 --idempotency-key STOP_KEY
armada orchestrator resume ID --org ORG --expected-revision 10 --idempotency-key RESUME_KEY
armada orchestrator events ID --org ORG --cursor CURSOR --follow --json
```

These examples describe requests, not an enabled runtime. The server controls
availability and authorization. A disabled capability or `unavailable` response
is not functional success. Native stop/resume requires server-side conformance;
the CLI never sends a synthetic prompt to simulate resume. No public wait or
private delegated-callback command is provided.

When at least one provider × harness pair is configured, `capabilities` also
lists every pair with `enabled` and a `reason`, and `harnesses`: per harness, the
suggested models and reasoning efforts (`MODEL_CATALOG`) and the credential kinds
whose named accounts can run it (`accountKinds`). Clients such as the iOS app
offer exactly these, so a new pair, model or harness needs no client release.

## Choices and defaults

Choose `claude` or `codex`, model, optional reasoning effort and a named account.
The server authorizes the selections and preserves native continuity. Omit
`--size` to use the server's selected-repository, golden, then legacy defaults;
an explicit canonical size overrides them. The CLI does not calculate resource
policy or infer capacity from a size label. Idle period is optional, in seconds;
server defaults apply when omitted. No default child limit, daily-start quota or
provider pacing is sent.

## MCP connections

Creation accepts `--connections ID1,ID2` or `--no-connections` (mutually exclusive).
Omitting both uses ordinary launch defaults at creation. Each connection must be
connected and usable by the owner in this organization; private parent visibility
does not authorize another member's personal connections.
An inaccessible selection is refused synchronously with `404 not_found`, before
reserving an asynchronous create or allocating a provider sandbox. The launcher
rechecks grants before binding them.

```sh
armada orchestrator create reviews --org ORG --golden GOLDEN --provider boat \
  --agent codex --model MODEL --model-account ACCOUNT \
  --connections CONNECTION1 --idempotency-key CREATE_KEY --json
armada orchestrator connections list ID --org ORG --json
armada orchestrator connections add ID CONNECTION2 --org ORG \
  --expected-revision REVISION --idempotency-key ADD_KEY --json
# Read detail for the new revision, then send the next instruction.
armada orchestrator connections remove ID CONNECTION2 --org ORG \
  --expected-revision NEW_REVISION --idempotency-key REMOVE_KEY --json
```

`add` and `remove` accept comma-separated connection IDs. Identical retries return
the original operation; a changed payload under the same key or a stale revision
conflicts. A pending/uncertain operation, a non-ready parent, an active turn, or
unproven native quiescence prevents changes. Running turns are **not queued**:
the response is a closed `409 conflict`, without selection/revision changes.
Wait until idle, read detail and submit a new request.

A successful mutation commits the desired set and fences old gateway leases.
Native preparation happens before the next admitted message. No VM or
conversation is recreated:
- **Boat × Codex:** the existing stdio bridge reloads native MCP configuration
  using acknowledged `config/mcpServer/reload` before the next turn.
- **Boat × Claude:** the stream-json bridge sends acknowledged `mcp_set_servers`
  controls and explicitly disables removed servers with `mcp_toggle` before
  forwarding the next user message. Unsupported controls or connection errors
  fail closed; no user message is forwarded. Fresh non-stream processes read the
  updated user configuration at startup.
  This Python bridge is installed only for managed parents, with an interpreter
  precheck; ordinary Claude repository/cwd preparation keeps its direct native
  wrapper. Unchanged configuration passes native mid-turn steer messages through
  without attempting an MCP refresh. A private durable installation receipt
  includes the physical boot, MCP generation and generated wrapper hash, so
  unchanged messages do not reinstall the wrapper. Generic GitHub preparation
  preserves the managed installation under the same root-owned installer lock.
- **Modal × Codex:** the runtime takes the new configuration snapshot for the
  next fresh app-server and resumes the existing native thread. The private epoch
  accepts external refresh only when quiescent and preserves its internal server.
  Modal × Claude remains disabled.

Preparation failure does not start a turn or silently clear connections: inspect
the operation/detail and repair the connection rather than assuming tools loaded.
Detail's `connections` and `connections` events contain only `{id, name}` entries.
`armada_orchestrator` and scoped internal authority are not registry connections,
are never listed here, and cannot be removed by these commands.

**Children do not inherit the parent's set.** A child always uses ordinary
owner-authorized launch defaults; scoped child launch has no connection override.
Parent selection grants no access to children; owner/grant checks still apply to
every child.

HTTP: `GET /api/v1/orchestrators/ID/connections` (query `orgId`) and
`POST /api/v1/orchestrators/ID/connections/add|remove` (JSON `orgId`,
`expectedRevision`, `connections`, plus `Idempotency-Key`). MCP tools:
`orchestrator_connections_list`, `orchestrator_connections_add` and
`orchestrator_connections_remove`, using the same fields in `args` and the
existing `idempotencyKey` envelope.

## Receipts, errors and reconnect

Every write requires a caller-chosen key. Keep the exact key and arguments for
recovery after an uncertain response; never generate a fresh key to retry an
unknown allocation. Surrounding spaces are rejected because HTTP would trim them.
Mutations also require the revision from detail/events. Do not replace it with a
new revision while recovering an existing operation. The server decides receipt
replay and conflicts. A receipt can be pending, succeeded, failed or uncertain;
admission alone is not completion. Failed/uncertain receipts exit nonzero.

JSON responses remain JSON. Errors are JSON on stderr with a nonzero exit code.
Events emit **one complete JSON page per line**, including the server cursor and
unknown event kinds. `--all` drains available pages; `--follow` continues polling.
On interruption or a failed poll, reconnect with the last delivered cursor.
Delivery is at-least-once across an interruption: deduplicate by event ID if a
page must be replayed. Cursors are opaque; never substitute provider cursors.
Polling is read-only and does not keep a runtime active.

## Recover a never-conversed Modal create

`armada orchestrator recover ID --org ORG --expected-revision ORIGINAL_REVISION
--idempotency-key RECOVERY_KEY --json` is a narrow owner recovery, not a generic
retry. It aborts an original pending/uncertain first create, with or without a
registered parent sandbox. It discovers its exact private Modal resource,
terminates/confirms it through Armada's fenced provider path, and publishes a
stop-kind receipt only after positive terminal proof. It never allocates a
replacement or requests model-account values. Keep the original key and revision
for reconciliation; do not generate new keys after uncertainty. A manual replay
of an unconfirmed recovery may idempotently terminate the exact same fenced
physical resource again; a successful receipt replay is read-only. No automatic
CLI retry or new allocation is performed. See
[troubleshooting](orchestrator-troubleshooting.md) for scope, proof requirements
and safe retry limits. A successful recovery keeps history and clears the old
create's busy fence, allowing a later ordinary stop; it does not invent native
continuity for a never-started conversation.

For automation in separate tool shells, prefix `ARMADA_URL` on each command rather
than relying on a prior shell export. The default public origin uses the dashboard
control proxy; its deployment must include the same owner routes as the backend.
Unstructured HTTP errors report the validated effective origin without echoing
upstream bodies or credentials. See [404 diagnosis](orchestrator-troubleshooting.md#a-404-before-recovery-admission).

## Pending create is admission

Create returns a durable pending receipt promptly; provider validation and
preparation run in the server worker. Keep its ID/key and poll detail/events until
**both** parent `state=ready` and its create operation `state=succeeded`, or a
terminal failure. Parent `ready` alone is not admission completion: initialization
may publish it before the create operation releases its busy fence. Sending or
stopping in that interval can return `conflict`; continue polling detail/events
rather than issuing a new create. Selection failures may arrive as failed preallocation
receipts rather than a synchronous create HTTP error. Replaying the same key and
payload discovers the same operation and never forks it again. Recovery also
supports a never-conversed registered pending first create; it is explicit abort,
not permission to resume initialization or adopt a newer generation.

### Optional Skillpack method

Create accepts `--skill example/notes@1.0.0` (API/MCP create: `skill`). This first
slice requires one exact public catalog pin. Install the released native
`skillpack` CLI in the golden beforehand; Armada does not download an installer.
Both Claude Code and Codex receive project-local discovery files before the first
turn. Detail includes `configuration.skill` and `skillReceipt` (origin, UUID,
version, checksum). Missing CLI/releases, conflicts and invalid receipts block
preparation without starting a turn; errors never include guest output.

Without `--skill`, only Armada's minimal launcher-tool reference is installed;
no orchestration method is selected. `ARMADA_ORCHESTRATOR_SKILL_REVISION` is no
longer required and remains only legacy receipt metadata. Only new creates receive
the built-in reference or selected skill. Existing parents retain the files already
installed in their project directory and are not re-bootstrapped, including on
resume. Creating a new parent does not remove skills inherited from a golden.

Private/share-token skills, custom origins and unversioned references are not
supported yet. No Skillpack credentials are inferred from Armada credentials.
See [investigation and design](orchestrator-skillpack.md) for safety, migration
and staging verification. Pinning identifies code, not trust: a selected skill
can instruct the parent to run commands and use its owner-scoped delegation.
