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

The single coordinator-owned [snapshot lifecycle check](docker-snapshots.md#coordinators-one-real-host-acceptance-check)
uses registered host `1bd0db41-6429-430b-99e2-06d60ddf1aa3`. It requires successful
archived Git/GitHub tool results, current-epoch broker delivery and retained
follow-up/resume memory, not assistant claims or configuration ACKs. No image
selection, hand-written labels or SSH preparation is required for that check.
Unit tests additionally cover explicit owner refresh and completed-prompt retries.
This procedure is not evidence that real-host acceptance passed.

The command-evidence matcher is Codex-only. GitHub access, readable bindings,
raw-secret references and [host-local snapshots](docker-snapshots.md) ship together
through the shared runtime paths. Apply the snapshot migrations and deploy
matching server/daemon/clients through normal operator procedures. Boat/Modal
goldens remain provider-specific and are not reusable Docker snapshots.
