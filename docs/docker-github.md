# Docker repository GitHub access

Docker repository launches use the same enrolled-runtime Git/gh broker as Boat.
The launch's frozen repository list is the allowlist; the caller must be able to
access every repository before allocation. Token acquisition revalidates current
membership, host/runtime epoch, GitHub connection and repository scope. Tokens
are registered for redaction before reaching Git/gh, never included in image,
launch arguments or public responses.

The shared runtime installs owner-local wrappers and helper configuration without
sudo or system binary writes. The sandbox owner owns this runtime and its local
IPC; owner-private permissions do not isolate the broker from other processes
running as that same owner. Server-side repository/connection/epoch checks remain
authoritative. The image needs Git, gh and Python3; `/home/user` must be writable
and owned by the sandbox user. Native Boat's legacy integration is unchanged.

`POST /api/v1/github/refresh` with `{ "org": "...", "id": "..." }` repairs an
owner's already-running repository sandbox without a new allocation or prompt.
The existing `github_refresh` MCP tool uses the same path. Only the owner can
refresh; an org administrator cannot acquire another owner's GitHub access.
`github/runtime-status` reports safe epoch, revision and credential delivery
counts, never credentials. Normal follow-up and resume automatically rebind
GitHub in the current runtime epoch before returning readiness/admitting a prompt.
Plain-image launches without repositories do not acquire GitHub authority.

## Coordinator acceptance

On registered host `70bde9cd-36c9-40af-b15e-65b2f9d3c2a2`, with the existing
server/org/account/image and SSH inputs and `ARMADA_TOKEN` only in the environment:

```sh
python3 scripts/smoke-docker-lifecycle.py \
  --server "$ARMADA_URL" --org "$ARMADA_ORG" --credential "$ARMADA_CREDENTIAL_ID" \
  --ssh "$ARMADA_DOCKER_SSH" --host-id 70bde9cd-36c9-40af-b15e-65b2f9d3c2a2 \
  --image "$ARMADA_DOCKER_IMAGE" --repository The-Vibe-Company/armada --branch main \
  --github --normal-lifecycle
```

One allocation: the initial prompt proves a repository `git log -1` and successful
`gh api repos/<repo> --jq .full_name`; explicit refresh and follow-up prove current
credential delivery and memory; same-host resume proves re-enrolment and GitHub
access in the retained conversation. The script requires successful archived
command results and a nonzero current-epoch broker delivery count, not assistant
claims or configuration ACKs alone. It stops/deletes once after verification.
This command is a procedure, not evidence that real-host acceptance passed.

The current command-evidence matcher is Codex-only and rejects repository checks
with `--claude` or `--opencode`. No migration is required. Deploy matching server
and runtime artifacts through the normal release. Variables, secrets and
host-local Docker environment images remain separate slices of #1464; Boat/Modal
goldens are built per provider and are not Docker images.
