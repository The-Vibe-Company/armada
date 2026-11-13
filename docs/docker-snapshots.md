# Docker snapshot provenance and listing

Issue #1528, slice 3a. This is the **catalog/read foundation**, not snapshot capture
or restore. No current route creates a snapshot, no stopped volume is relabeled
as a snapshot, and listing metadata does not prove that local snapshot bytes
exist or authorize a launch. Until capture is implemented, normal lists are empty.

A completed host-local snapshot's catalog entry records its private owner,
organization, host installation, name, official Armada image version and immutable
GHCR digest. A replacement host installation cannot be substituted into an entry.
Neither a user JWT nor the host machine credential can register or modify entries.
The future trusted capture service must insert only after verified host completion,
using the build's frozen official pin, never a client-reported version or digest.
The database validates current host/organization/installation binding on insertion
and makes provenance immutable. Rebuilds must create new entries; they must not
rewrite an old snapshot's version or image.

## Read API / CLI

`POST /api/v1/docker/snapshots/list` with `{org, hostId}` uses the existing user
bearer authentication and Docker-host opt-in. It returns `{snapshots: [...]}`.
Each item includes `id`, `hostId`, `name`, `officialImageVersion`, `officialImage`
and `createdAt`. Only the private owner who is still an organization member can
read an entry, even if another member is an administrator. SQL enforces the same
scope explicitly as RLS. A removed member cannot list; an unknown/cross-org host
is denied. Old catalog entries remain readable after host revocation/reinstallation
but this does not imply they can be restored on the current machine.

```sh
armada host snapshots HOST_UUID_OR_EXACT_NAME --org ORG_UUID
armada host snapshots HOST_UUID --org ORG_UUID --json
```

The text list shows **Built on Armada** for every saved entry. There is no image
selector, capture command, automatic rebuild or new provider/golden alias.

## Remaining slices / deployment

The capture/storage job and local-byte ownership/retention protocol, snapshot
selection at launch, dashboard snapshot list and explicit update/rebuild flow
remain to implement. They must preserve old snapshots and avoid recording secrets
or foreign provider artifacts. Do not expose catalog-write APIs as a shortcut.

Migration `20261113180000_docker_snapshot_provenance.sql` must precede the matching
server rollout through normal reviewed deployment. This work only generated types
and exercised disposable local SQL tests; no remote migration or deployment was
performed. Recheck its version against current main before merging.
