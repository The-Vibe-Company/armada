# Immutable host-local Docker images

Normal Docker launches do not accept caller-selected image strings. The server
selects its official environment, or resolves an authorized host-local snapshot
selected by `--golden SNAPSHOT_UUID`. The product builds snapshots from the
versionable golden file and creates all provenance labels automatically. See
[host-local snapshots](docker-snapshots.md) for commands, private/org authorization
and the single coordinator check on host
`1bd0db41-6429-430b-99e2-06d60ddf1aa3`. No hand-written labels are required.

Internally the machine/mailbox and database binding accept registry manifest
references `repository@sha256:<64 lowercase hex>` and full local image IDs
`sha256:<64 lowercase hex>`. These are distinct Docker content-addressed identities,
not mutable tags, short IDs or inferred registry aliases. This is a machine
primitive, not permission to choose an arbitrary cached image through normal launch.

Before allocating from a local image, the daemon inspects its exact ID and
requires this installation and host's immutable provenance. A private snapshot
also requires the signed server-authorized source ID, owner and visibility binding.
An image ID alone cannot bypass the snapshot catalog's authorization. Missing
images, foreign provenance or an inspect ID mismatch fail closed without pull/tag
fallback. Lifecycle operations on an already-owned allocation do not require its
source image to remain cached. A trusted host operator still controls its own
machine's images and workloads.

`capabilities.goldens` is true when normal Docker placement/snapshot builds are
enabled. This is not a Boat/Modal alias: build the same config separately for each
provider or host installation.

Migration `20261113170001_docker_local_image_ids.sql` introduces local image IDs;
`20261113190000_docker_snapshots.sql` adds their scoped catalog/publication.
Apply through operator procedures before matching binaries. Update old daemons
before sending build jobs. No compatibility fallback or remote deployment is
performed by a worker.
