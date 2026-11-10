# Sandbox lifetime investigation (#851)

The baseline below records main before implementation. The initial delivery
section describes the implemented extension/expiry scope; the proposed design
also includes recovery and client-warning follow-ups that are not claimed here.

## Baseline behaviour before implementation

| Provider / harness | Enforcement and Armada row | Retention and prompt after expiry |
| --- | --- | --- |
| Boat / Claude Code and Codex | `createBoatProvider.fork` passes launch TTL to Boat. Armada independently reconciles `expires_at` in `createSandboxLifecycle`; confirmed archive becomes `stopped`. No closed `expired` status reason is written. | Boat stop saves disk, including conversation state. The adapter resumes stopped compute before prompting in the serve composition, and send defaults to the last conversation ID. Retention is provider-controlled: Boat terms make stopped data eligible for cleanup after 14 days, not a permanent guarantee. No specific closed non-restorable result exists in Armada. |
| Modal / Claude Code and Codex | `create` passes the same TTL as `timeoutMs` and sets `grantExpiresAt`. A provider timeout can therefore beat Armada's stop. `get` reports `physicalExitConfirmed`, and reconciliation marks the row `failed`, not a retained stop. | Explicit stop runs runtime checkpoint and filesystem snapshot before termination. Resume creates a new physical generation from `recoveryImageId`, then resumes the native session. Provider timeout does not run this path: current writes have no verified checkpoint and prompt refuses activation. Snapshot TTL is null, but Armada may collect unreferenced images; this is not a retention promise. |

Sources in tree: `packages/mcp-server/src/sandbox-lifecycle.ts`,
`work-preservation.ts`, `tools.ts` send; `packages/provider-boat/src/provider.ts`;
`packages/provider-modal/src/provider.ts` (`create`, `readyLeased`, `get`,
`stopLeased`, `checkpoint`). Both harnesses use these lifecycle paths; no live
provider/harness recovery test has been run by this investigation.

Dependency evidence: Boat SDK 1.13.0 `UpdateSandboxRequest.ttlSeconds` explicitly
sets a new deadline of now plus TTL; `ResumeRequest` preserves the stored TTL
when omitted. Modal SDK 0.11.1 exposes `timeoutMs` at create but no public
in-place lifetime update. Modal's documented physical lifetime maximum is 24h.

Official references:
- <https://boat.dev/terms> (stopped-data retention)
- <https://modal.com/docs/guide/sandboxes> (timeouts and snapshot replacement)

## Proposed bounded design

1. Separate Armada's logical expiry from provider hard expiry. Do not implement
   extension as a database timestamp edit while leaving the provider timer at
   the original launch TTL. Boat can reset its timer. Modal must be created with
   headroom, and any extension must fit *inside the existing physical deadline*
   with a preservation margin; reject requests beyond it without side effects.
   Do not silently replace a running physical machine to extend its life.
2. Add an owner/admin-authorized extension operation shared by API, CLI, MCP and
   scoped child tools. Use the existing activity/generation fences to serialize
   it against stop/resume/reconciliation. Validate duration on the server, reject
   stopping/terminal resources and cap at provider maximum and physical headroom.
   A provider deadline shorter than requested must never be published as success.
3. Reconcile logical expiry before provider timeout. Acquire stop ownership, block
   new turns, await clean interrupt, preserve work (#747), then invoke the same
   checkpoint/stop path as explicit stop. Preserve `expired` as the reason after
   stop confirmation. Audit the preservation timeout carefully: the current
   best-effort timeout is not proof that a turn has settled.
4. Resume retained expired stops through send with the previous conversation ID
   and a freshly validated logical lifetime. A provider-missing disk/checkpoint
   must produce a closed non-restorable reason and retain any work recovery
   reference. Never resume an older Modal snapshot as if it contained current
   writes after a physical timeout.
5. Expose one server-derived expiring-soon flag on status and list. Do not add
   auto-extension: it changes cost and lifecycle policy and is not required for
   this repair.

The provider hard-deadline/headroom contract must include runtime grants and MCP
lease expiry, not just SQL `expires_at`. Existing Modal machines without headroom
cannot safely receive an extension beyond their physical deadline.

## Required staging verification (not performed)

For each provider and harness, launch from a staging golden with a two-minute
logical lifetime; give it a random non-secret recall token and create an
unpushed change. Let it expire once while idle and once while a turn is running.
Verify clean interruption, stopped/expired status and recoverable work, then send
another prompt using the same sandbox ID and require recall of the original
token and inspection of the unpushed change. Separately extend before expiry and
verify the original deadline passes without stopping. Repeat with a removed
provider disk/checkpoint and require an explicit non-restorable response with the
work recovery reference. Do not run these destructive checks against production.

## Initial delivery scope

This PR implements points 1 and 2 of #851. Recovery/error closure is tracked in
#854; the expiring-soon projection is tracked in #855. Existing retained-stop
resume remains available, but this PR does not claim the complete recovery matrix.

Ordinary launches reserve a five-minute stop margin between the logical expiry
and the provider's hard deadline. Boat uses logical TTL + 300 seconds and resets
its live timer when extended. For ordinary Modal launches, including coordinator
children, the physical launch timeout is:

`min(24 hours, effective logical TTL + 300 seconds + server extension headroom)`

The server setting `ARMADA_SANDBOX_EXTENSION_HEADROOM_SECONDS` defaults to 3600
seconds and accepts whole seconds from 0 through 86100. Requested maximum launch
lifetimes are capped to leave the stop margin; the launch response reports the
effective TTL. Managed parents retain their separate lifecycle policy.

Modal extensions must fit before the existing physical/grant deadline minus
300 seconds. A longer request is refused, never implemented by replacing the
running machine. Existing Modal machines cannot gain missing physical headroom
retroactively. A stopped/resumed Modal worker receives a fresh physical machine
through the existing restore path.

Operational tradeoff: during an Armada outage, the worst-case compute cost is
bounded by the physical launch timeout above, not always 24 hours. A high logical
TTL or configured headroom can reach the 24-hour provider cap. The provider timer
remains a hard cost bound, not a work-preserving stop. Server outages lasting
beyond the reserved stop margin cannot guarantee a clean checkpoint.

Deploy the additive constraint migration before the new server. Existing parent
epochs do not acquire `worker:extend`; stop/resume a parent to install a fresh
scoped grant. An application rollback can leave the expanded constraints in
place (no data rewrite or destructive rollback is needed).
