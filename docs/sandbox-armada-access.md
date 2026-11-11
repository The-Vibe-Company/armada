# Opt-in sandbox Armada access (#983, slice 2)

An ordinary sandbox can receive scoped Armada MCP access without becoming an
orchestrator. Armada supplies access, not an orchestration method; install your
method separately using existing pinned Skillpack launch skills.

## API / CLI

`POST /api/v1/sandbox/launch-access-v1` accepts normal launch fields plus
`armadaAccessVersion: 1`, `armadaAccess: true` (or
`{ "maxActiveChildren": 3 }`) and an explicit named `credentialId`. Limits are
1–100, default 3. Existing launch routes also accept `armadaAccess`; omitted or
false leaves access disabled. The versioned route prevents an older server from
silently launching an access-enabled CLI request without access.

```sh
armada launch my-golden --agent codex --credential-id ACCOUNT_ID \
  --armada-access --max-active-children 3 "Your task"
```

The parent is private, including from a shared golden, and remains visible through
ordinary sandbox APIs. Use ordinary status/logs/send/stop with its sandbox ID.
Sending a follow-up to a retained stopped sandbox uses existing conversation
resume. No synthetic resume prompt or orchestrator identity is introduced. In the
dashboard launch dialog, Advanced → Armada access is off by default and requires
a usable named Codex account. It explicitly limits access to three owned children;
switching to Claude clears it. iPhone launch forms are unchanged.

## Access and safety

The existing native MCP server name is `armada_orchestrator`. Tools are launch,
read, message, stop and extend. `read` returns status and a bounded event tail so
an agent can read its child's answer. Poll read to wait; no delegated wait tool
exists. A nonsecret armada-tools reference documents schemas and idempotency.
There is no owner CLI token, credential administration or arbitrary sandbox access.

Only the parent's selected golden/account can launch children. Current owner/org
membership and account authorization are rechecked; messages/read/stop apply only
to that parent's attributed children. Epochs last at most 24h and are bound to SQL
lifecycle and physical generation. Native pre-prompt preparation reuses a valid current grant or renews access
after activation. Pending/uncertain allocations count against the child cap; reuse
idempotency keys and identical arguments after an ambiguous response.

Authority uses existing private provider transports, never prompt/exec arguments,
golden or checkpoint files. Stop revokes, quiesces and scrubs before checkpointing;
scrub failure prevents stop. Modal's runner independently refuses checkpointing a
live epoch. A sandbox without the opt-in has no delegated Armada connection.

## Investigation: what remains different

Orchestrators never had an owner Armada CLI/token either: they received this same
scoped MCP grant and reference, with an optional external Skillpack method. Parent
allocation is promptless and children use durable preallocation/idempotency receipts,
owner/org attribution and concurrency policy. Those shared mechanisms are reused.

The old orchestrator additionally has a separate revision/CAS operation API,
no-text verified native resume, idle/wait-lease policies and dedicated event/usage
projections. These are not recreated for ordinary sandboxes. Ordinary send resumes
a retained conversation; the orchestrator's verified no-text Modal resume is not
exposed. Boat memory continuity remains best effort, not native session proof.
Shared broker/epoch/child infrastructure (including legacy internal names) must
survive removal of the public orchestrator UI/API.

## Deployment and coordinator staging checklist

Apply `20261111140000_sandbox_armada_access.sql` via the normal deployment process,
not from an agent. Existing `ARMADA_ORCHESTRATOR_PAIRS` enablement for
`boat:codex`/`modal:codex` currently composes the shared scoped gateway; a launch
option cannot enable an unavailable pair.

The coordinator runs these checks **after the authorized staging rollout**, once
for Boat/Codex and once for Modal/Codex. They are post-merge operator checks,
not a claim of real-provider validation by this PR.

- [ ] Launch a private parent with `--armada-access --credential-id ACCOUNT_ID`.
  Supply the selected golden/account IDs and account version in its task.
- [ ] Ask it to launch a child, message it, poll delegated `read` until the
  answer appears (the existing delegated gateway has no blocking wait tool),
  then stop the child. Record parent/child Armada IDs and response evidence.
- [ ] Stop the parent through ordinary sandbox APIs, then send a follow-up.
  Verify retained task/child memory and that newly active authority can read
  the child while the old grant is refused. Do not log raw grants.
- [ ] Launch a no-option control; verify it has no delegated connection and
  cannot authenticate to the delegated gateway. This is an authority fence,
  not an outbound-network firewall or a ban on separately supplied user tokens.
- [ ] Confirm a launch beyond the configured active-child cap is refused
  without new allocation, including while a previous allocation is uncertain.
- [ ] Confirm a refused busy-parent send leaves its current tools functional,
  and failed scrub prevents a checkpoint/stop from persisting the live grant.

Record failures as provider/staging evidence and retain failed resources for
safe investigation. Local tests/CI do not establish this live proof; this agent
neither deploys nor applies migrations to staging/production.
