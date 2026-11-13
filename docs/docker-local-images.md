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

## Deployment and the coordinator's one check

The new append-only constraint migration is
`20261113170001_docker_local_image_ids.sql`. Apply it through the normal operator
procedure before server traffic uses local IDs; deploy matching host daemon,
server and clients. Old daemons must be upgraded before sending them the new
reference form. No remote migration/deployment is performed by this PR.

On host `70bde9cd-36c9-40af-b15e-65b2f9d3c2a2`, use an existing dedicated,
secret-free Linux x64/glibc local image with Git/gh/Python3 and suitable UID1000
workspace permissions. Its labels must explicitly approve this host and its
current installation for org-shared use. Obtain its full image ID privately on
that host; never substitute a mutable tag or mark a private workload image as
shared. With the existing server/org/account/SSH inputs and ARMADA_TOKEN only in
the environment:

```sh
python3 scripts/smoke-docker-lifecycle.py \
  --server "$ARMADA_URL" --org "$ARMADA_ORG" --credential "$ARMADA_CREDENTIAL_ID" \
  --ssh "$ARMADA_DOCKER_SSH" --host-id 70bde9cd-36c9-40af-b15e-65b2f9d3c2a2 \
  --image "$ARMADA_DOCKER_LOCAL_IMAGE_ID" --normal-lifecycle
```

`ARMADA_DOCKER_LOCAL_IMAGE_ID` is exactly `sha256:<64 lowercase hex>`. The script
uses one allocation through normal launch, requires the exact image echoed in
its receipt, proves retained conversation through follow-up and same-host resume,
and stops/deletes once. This procedure is not evidence of a real-host pass and
does not claim the later config-file environment builder is implemented.
