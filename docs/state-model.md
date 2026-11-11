# Implemented lifecycle state model

Audit baseline: 2026-11-10, issue #829. This describes the implementation, not
a promise that a configured provider passes deployed conformance. See
[smoke boundaries](consolidation-audit.md) and [error codes](api-error-codes.md).

## Ordinary sandbox

The persisted enum is `starting | ready | running | stopping | stopped | failed |
deleted` (`packages/core/src/database.types.ts`). Provider state is a separate
observation, never interchangeable with this enum.

| Operation / writer | Transition and evidence |
| --- | --- |
| Launch (`core/src/launch.ts`) | Insert starting; initialization publishes ready, or failure records failed. A prompt can begin running. |
| Send / turn tracking (`mcp-server/src/tools.ts`, `turns.ts`) | Admit activity under a lease; running reflects a turn, not a new machine. Completion can return to ready or record failure. |
| Stop (`tools.ts`, `sandbox-lifecycle.ts`) | Reserve stop, attempt bounded best-effort preservation, request provider stop; stopping is not proof of physical exit. |
| Reconcile (`sandbox-lifecycle.ts`) | Lease and generation-fence observations; stop on explicit request, interrupted starting, or expiry. Confirmed terminal provider state records stopped; failed launches retain failed and their diagnostic. Physical exit without verified recovery records failed. |
| Resume (`tools.ts`) | New activity/generation fences stale observations; restore retained compute and initialization before readiness. Not a fresh golden launch. |
| Delete (`tools.ts`, `data.ts`) | Owner/current org admin, terminal unmanaged row only; provider deletion must be confirmed before metadata/archives are deleted. |

The reconciler retries unavailable observations without inventing deletion.
A failed row with `stopped_at` is already terminal for reconciliation; a failed
row without it can still own compute. `deleted` is terminal. Stop may leave
`stopping` until retry/observation succeeds. Loss of membership or provider
credentials can prevent that retry from resolving; this is not proof of exit.
Ordinary retention is separate from stop. Managed parents are excluded from
ordinary reconciliation/retention so it cannot bypass their checkpoint protocol.

## Orchestrator parent

The parent enum is `creating | ready | stopping | stopped | resuming | blocked | failed`
(`core/src/orchestrator.ts`). There is no parent `deleted` state.
A proven pre-allocation create refusal ends `failed`: no machine exists to recover.
The closed `credential_busy` reason carries an actionable safe message in the
operation receipt/events and parent detail; unknown allocation outcomes stay
recoverable rather than being declared terminal.
The parent, its sandbox, its operation ledger and provider machine are four
different records.

| Operation / writer | Transition and evidence |
| --- | --- |
| Create (`orchestrator-runtime.ts`, create jobs) | Reserve an idempotent pending create, allocate once, install/bind authority; publish ready on successful setup. Inspect the operation too: ready alone is not an admission receipt. |
| Message / steer (owner runtime) | CAS revision plus idempotency key reserve a receipt, revalidate authority, dispatch and publish result. Receipt success means admission, not a finished agent turn; inspect events. Blocked parents refuse admission. |
| Stop (owner or lifecycle worker) | Close admission, stopping, perform native checkpoint for Modal or ordinary retained stop for Boat; confirmed receipt publishes stopped. Ambiguity publishes blocked/unverified, never fabricated native continuity. |
| Resume (owner runtime) | stopped → resuming → ready on correlated restoration. Modal validates native identity; Boat is best-effort and may continue with a fresh conversation and previous_conversation_not_continued note. Failure can block, with unverified/lost continuity. |
| Recover (owner recovery services) | Supported uncertain-create/stop and legacy Boat recovery shapes are reconciled using durable identity/receipts. Confirmed retirement publishes stopped. It is not an unrestricted reset of any blocked row. |

Operation kinds are `create | message | steer | stop | resume`, with states
`pending | succeeded | failed | uncertain`. Recovery is exposed as an owner
action but records a stop receipt. A replay with the same key returns its
recorded operation; a changed payload conflicts. Unknown outcome requires
inspection/reconciliation, not another allocation.

Owner HTTP/MCP requests use verified identity; delegated private authority can
only operate on admitted children. The idle/expiry worker requires fenced
observations and quiescence, not absence of events. SQL revision,
`lifecycle_generation`, authority epoch and native `physicalGeneration` are
distinct fences. Continuity is `not_started | native | unverified | lost`;
Boat never earns a native checkpoint claim.

## Disagreement and exit inventory

- Parent ready and pending create can coexist during publication; clients must
  inspect the operation. This is an intentional publication/admission distinction,
  not a new readiness guarantee; retain both checks. Deployed cycle coverage is
  tracked in [#832](https://github.com/The-Vibe-Company/armada/issues/832).
- Provider stopped/archived and SQL stopping can disagree until reconciliation;
  neither a timeout nor an HTTP failure proves that stop failed physically.
- Loss of membership or provider credentials can strand an ordinary stopping
  row: high-risk [#857](https://github.com/The-Vibe-Company/armada/issues/857)
  tracks a trusted, exact-identity cleanup exit without restoring removed authority.
- A blocked parent has only the recover paths supported by its recorded shape.
  There is no general delete/reset transition. Do not repair by SQL or infer
  quiescence from empty events. High-risk
  [#858](https://github.com/The-Vibe-Company/armada/issues/858) tracks a narrow
  owner retirement exit for unsupported blocked receipt shapes.
- Preservation docs formerly required Python although the collector uses Bun;
  corrected in this audit. Preservation failure is a note, not a stop veto.
- Error surfaces disagree on several HTTP mappings; the catalogue records actual
  precedence rather than normalizing behavior in a documentation PR.
