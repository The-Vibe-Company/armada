# Immutable host-local Docker images

Normal Docker launches accept either a registry manifest reference
`repository@sha256:<64 lowercase hex>` or a full host-local image ID
`sha256:<64 lowercase hex>`. Docker's [content-addressable image store](https://docs.docker.com/reference/cli/docker/image/pull/)
uses image IDs separately from registry manifest digests. Short IDs, mutable tags,
uppercase/noncanonical hashes and inferred registry aliases remain refused.

The shared core validator is used by normal/private server admission, the host
mailbox parser and machine executor, CLI and dashboard image parsing. The database
binding constraint accepts both immutable forms while preserving all existing
private-owner, host, harness and lifetime restrictions. Image strings returned by
normal launch/status stay unchanged; no new provider/status/source enum appears.

## Host approval, not arbitrary cache access

A full local ID alone is not permission to run any image cached on the machine.
Before allocating a new volume/container, the daemon inspects that exact ID and
requires these immutable image configuration labels:

- `dev.armada.environment.installation`: this daemon's installation UUID;
- `dev.armada.environment.host`: this registered host's UUID;
- `dev.armada.environment.scope`: `org` (explicit host-operator approval for org-shared use).

Missing images, foreign host/installation labels, private/unapproved images or an
inspect ID mismatch fail closed before allocation. There is no pull/tag fallback.
Existing registry-digest behavior is unchanged. Stop/delete/resume of an already
owned allocation does not depend on the shared image cache still being present.
These checks do not replace host trust: a Docker daemon operator already controls
all local images and workloads. Do not mark private images as org-shared.

This is the runnable image-reference prerequisite for #1464's host-local
Docker environments, **not** the golden-file builder/publication feature.
`capabilities.goldens` remains false. Future builders must produce approved,
secret-free host-local images; no Boat/Modal snapshot alias is introduced.
Private Docker environment authorization and versionable repos/branches/init
build/publication remain later work.

## Product snapshot builds and deployment

Prefer `golden create --provider docker --host ... --config ...` and launch with
`--golden SNAPSHOT_UUID`. The product creates the labels; nobody prepares them by
hand. Private images additionally require an authorized snapshot binding.
See [host-local snapshots](docker-snapshots.md) for the single coordinator check
on host `1bd0db41-6429-430b-99e2-06d60ddf1aa3` and normal build/launch commands.

Migration `20261113170001_docker_local_image_ids.sql` introduces local image IDs;
`20261113180001_docker_snapshots.sql` adds their scoped catalog/publication.
Apply through operator procedures before matching binaries. Old daemons must be
updated before these build jobs; no compatibility fallback or remote deployment
is performed by a worker.
