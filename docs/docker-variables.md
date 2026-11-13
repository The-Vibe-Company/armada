# Readable variables on Docker

Normal Docker launch accepts value-free, versioned `variables` bindings, using
the same shape, key restrictions, scope checks and size limits as templates:

```json
{"key":"APP_REGION","variableId":"<readable-variable-uuid>","version":1}
```

Pass an array in the normal launch request's `variables` field, or repeat the
existing CLI syntax `--variable APP_REGION:UUID:VERSION`. Manage source values
through the existing `armada vars` stdin/file commands; launch never accepts
raw environment overrides or model/provider credentials.

Admission resolves authorized personal/org variables in the allocation
transaction using the shared template resolver. Wrong versions, other owners'
personal variables, forbidden keys and oversized environments fail without
allocating. Copied values are frozen in the encrypted launch manifest; editing,
revoking or deleting a source does not recall a launch's readable configuration.
A new launch must bind the source's current version.

Before the first prompt, normal follow-up and same-host resume, the server uses
the existing enrolled runtime `configureReadableVariables` operation. Only the
selected native harness receives these values; init/ordinary exec keeps its
separate environment. This is configuration, not a confidentiality boundary:
the agent and sandbox owner may read/copy/exfiltrate values. No secret binding,
secret-safe logs, erasure, taint or snapshot guarantee is added by this slice.

`launch/options` advertises `capabilities.variables` when normal Docker launch is
enabled. Older clients/servers may omit this additive boolean; the dashboard
reads absence as unsupported. No new provider, harness, status or enum value is
introduced. The shared core binding/parser is also used by launch templates.

## Coordinator's single real-host check

On host `70bde9cd-36c9-40af-b15e-65b2f9d3c2a2`, select an existing authorized
readable variable/version. Set its non-secret expected value in
`ARMADA_DOCKER_VARIABLE_EXPECTED` privately in the coordinator environment;
`ARMADA_TOKEN` also stays environment-only:

```sh
python3 scripts/smoke-docker-lifecycle.py \
  --server "$ARMADA_URL" --org "$ARMADA_ORG" --credential "$ARMADA_CREDENTIAL_ID" \
  --ssh "$ARMADA_DOCKER_SSH" --host-id 70bde9cd-36c9-40af-b15e-65b2f9d3c2a2 \
  --image "$ARMADA_DOCKER_IMAGE" --repository The-Vibe-Company/armada --branch main \
  --github --normal-lifecycle \
  --variable "APP_REGION:$ARMADA_DOCKER_VARIABLE_ID:$ARMADA_DOCKER_VARIABLE_VERSION"
```

One allocation: archived successful `git log -1`, gh API and `printenv APP_REGION`
results, with the exact variable value absent from the model prompt. Subsequent
and resumed turns must also prove that value and retained memory. Assistant
claims/configuration ACKs alone cannot pass. Current evidence matching is
Codex-only; Claude/OpenCode combinations are explicitly refused by the script.
This is a procedure, not evidence of a real-host run.

Requires the preceding Docker repository/GitHub slices and matching server/runtime
release. No new migration or manual artifact publication. Secret bindings and
host-local environment image builds remain separate #1464 slices; Boat/Modal
images remain provider-specific, not reusable Docker snapshots.
