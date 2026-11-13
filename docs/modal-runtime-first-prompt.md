# Modal: enrolled Codex prompt and follow-up (#1421)

This is a coordinator-owned, **billable staging check**, not a worker task or a
production cutover. It creates exactly one Modal sandbox, never retries an
allocation, proves a model answer and same-conversation recall through the common
runtime archive, performs an acknowledged checkpoint, and requests compute stop
exactly once. No resume, filesystem preservation, GitHub, MCP, skills or harness
parity is claimed. This remains model-only: the golden checkout is used as-is.
The existing Modal tunnel path remains the default.

## Prerequisites

Deploy the matching server/runtime revision and current schema through the normal
staging deployment process. The worker does not apply migrations or deploy.
The server image publishes the compiled artifact and manifest automatically;
there is no manual artifact-publication step.

Coordinator staging configuration:

- `ARMADA_MODAL_DIALOUT=1` explicitly enables this staging-only launch route.
- `ARMADA_MODAL_RUNTIME_MANIFEST=/opt/armada/runtime-manifests/x64.json` selects
  the manifest from that deployed build for the Modal Linux x64 target.
- Existing authorized Modal management credentials and immutable workspace,
  environment and App binding, with an existing snapshotted Modal golden.
- An authorized Codex API-key/custom-endpoint account. Subscription login is
  not admitted by this first slice (no broker/native-auth publication is wired).

In the coordinator's secure environment, supply:

- `ARMADA_URL`: the staging **armada-server HTTPS origin**, not the dashboard.
- `ARMADA_TOKEN`: existing authorized Armada bearer, never in argv or logs.
- `ARMADA_RUNTIME_ORG`: the staging organization selection.
- `ARMADA_RUNTIME_GOLDEN`: the existing Modal golden name.
- `ARMADA_RUNTIME_CREDENTIAL_ID`: the authorized Codex model-account UUID.
- Optional `ARMADA_RUNTIME_MODEL`: an account-supported model.

## Single coordinator check

```sh
ARMADA_RUNTIME_SMOKE=one_real_modal_launch bun scripts/check-modal-runtime.ts
```

The script preflights `launch/options.modalRuntime {version:1,enabled:true,followupVersion:1}`
before allocating. It sends one `sandbox/launch-modal-runtime-v1` request with
`runtimeVersion:1`, `runtimeTransport:"dialout"`, `provider:"modal"`,
`harness:"codex"`, a 900-second TTL, empty connections/skills and skill defaults
skipped. The golden checkout is used as-is. The first prompt stores a random
memory token and asks for a separate literal
nonce answer, without tools or file changes. After verifying that archived first
answer, the script sends exactly one follow-up on the same conversation asking
for the remembered token **without repeating it in the follow-up prompt**.
The follow-up request UUID is printed before dispatch. A lost/uncertain response
is not retried; reconcile that same request UUID.

Success requires all of:

1. The launch receipt identifies the Modal sandbox, immutable `dialout` route,
   `runtime.kind:"armada"`, current epoch and prompt ID.
2. `logs/read` identifies `source:"armada-runtime"` and contains that prompt's
   non-partial, non-retracted main assistant nonce answer plus a finished event.
   Tool-result text, another prompt, Modal native ingest or selection metadata
   alone cannot pass.
3. The one `sandbox/send` receipt identifies its original request UUID, a new
   prompt ID, the same conversation and current epoch. The archive must contain
   that follow-up prompt’s exact recalled token and finished event. An old
   answer, another prompt, wrong epoch/conversation or reused prompt ID fails.
4. `sandbox/checkpoint-runtime-v1` returns the same epoch and request ID with a
   complete, nonnegative watermark equal to the durable acknowledged sequence.
5. The one stop request is followed by confirmed stopped metadata. Stop is also
   attempted after inference/follow-up/checkpoint failure when the sandbox ID
   is known.

Expected output: a JSON receipt with sandbox/prompt IDs, epoch, archive source,
`answer:"verified"`, `followup:"verified"`, `checkpoint:"verified"`, both prompt
IDs and the conversation ID, then a compute-stopped message.
No response text or model/provider credentials are printed.

If launch transport fails or its receipt omits the sandbox ID, allocation outcome
is unknown: **inspect existing allocations before doing anything that retries**.
The script does not create a replacement. If cleanup is unconfirmed, inspect the
reported sandbox immediately. A known first failure is not a reason to skip
cleanup, and cleanup is not evidence of resume or disk preservation.

Record the exact server revision, receipt and observed result on #1421's parity
table. Local fixtures and green CI are not real Modal inference evidence. Do not
flip defaults or delete the tunnel path until the later parity and cutover gates.
