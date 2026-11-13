# Host-local snapshots

Docker snapshots are built on their registered host from the same versionable
`{repos, init}` golden JSON used for Boat/Modal. They are immutable image artifacts,
not aliases for foreign provider snapshots. Snapshot builds require GitHub access,
not a model account. The product applies host/installation, owner, visibility,
source-definition and generation labels automatically.

```sh
armada golden create office --provider docker \
  --host 1bd0db41-6429-430b-99e2-06d60ddf1aa3 --org "$ARMADA_ORG" \
  --config armada.golden.json --private
armada golden list --provider docker --org "$ARMADA_ORG"
armada golden get SNAPSHOT_UUID --provider docker --org "$ARMADA_ORG"
armada launch "Work on this project" --provider docker --golden SNAPSHOT_UUID \
  --org "$ARMADA_ORG" --credential-id "$ARMADA_CREDENTIAL_ID"
```

Creation returns a stable request/snapshot UUID while building. Reuse the printed
`--request-id` and identical input after an unknown create outcome; do not start a
second build. Launch selects the snapshot, not an image or host: server-side
resolution pins both and checks current authorization again at reservation.
Ready snapshots launch the baked workspace without another checkout/init.
In the dashboard, choose **Snapshots → New → Your host · Docker**, select the
registered host and upload the same golden JSON. Private is the default; admins
may publish to the organization. Building and offline artifacts remain visible.
A ready snapshot opens the normal launch dialog with your model account, skills
and MCP connections. Sandboxes → Launch a sandbox leads to this same list,
including in organizations with only an owned host and no cloud provider.

Private snapshots are visible/launchable only by their owner, including against
org admins. Org snapshots require an admin to build and may be used by current
org members. JWTs have read-only RLS access to metadata, no build/publication
writes or mailbox credentials. A private image ID alone cannot bypass snapshot
access: signed machine requests must carry the exact authorized source binding.
Source visibility is immutable; build a new artifact to publish a different scope.
Host re-registration needs a new build for that installation; old host identities
are not silently rebound.

The host uses BuildKit's private secret pipe/mount, the shared golden checkout
frame and the shared fail-closed filesystem/Git-object scanner. The GitHub token
is available only to trusted root checkout. Each project init step runs separately
as UID1000 with no-new-privileges; it cannot read the root-only mount, replace the
root-owned controller/scanner, skip later steps with `exit 0`, or suppress the
independent final root scan. Trusted root supervision subreaps and kills all init
process descendants (including new sessions), using process birth and pidfds,
before the next step or scan can start. No model/application credentials enter a build.
Build context and durable host receipts contain no token. Publication occurs only
after successful build/scan and exact immutable provenance verification. Known
pattern scanning is not a proof against arbitrary encoded/user-supplied secrets:
never put credentials in repository/config/init content.

There is one active build per host and a one-hour deadline. While building, the
daemon continues ordinary mailbox work and physical TTL sweeps. Recovery adopts
only a matching already-built image; an unknown unfinished build is not replayed.
Current creator/issuer epochs and visibility authorization are checked before
credential delivery and publication. Images do not become ready on configuration
ACK alone. The trusted host operator can always read its own machine's contents.

The image includes a product-written, root-owned `/opt/armada-build/receipt.json`
with its snapshot identity, host, definition and completed init plan. Normal
runtime installation and harness/model/account handling remain the shared paths.
Current-owner GitHub access is prepared for snapshot launch/new turns/resume;
a copied snapshot does not delegate its builder's GitHub identity.

## Coordinator's ONE real-host acceptance check

Use the existing authorized config file and account, with ARMADA_TOKEN in the
environment. No image identifier, hand-written labels, proof file, SSH setup or
special init marker is required:

```sh
python3 scripts/smoke-docker-lifecycle.py --server "$ARMADA_URL" \
  --org "$ARMADA_ORG" --credential "$ARMADA_CREDENTIAL_ID" \
  --host-id 1bd0db41-6429-430b-99e2-06d60ddf1aa3 \
  --snapshot --config "$ARMADA_DOCKER_GOLDEN_CONFIG" --normal-lifecycle
```

One build and one workload allocation: the script waits on the printed artifact
ID, then requires the exact image/source receipt, successful archived Git log,
GitHub API plus current-epoch broker delivery, and product build-receipt tool
output through follow-up/resume, with retained memory and normal cleanup. The
snapshot remains usable afterward. It never treats assistant claims as proof.
The current tool matcher is Codex-only. Real-host acceptance is coordinator-owned;
this procedure is not evidence it passed.

Migration `20261113180001_docker_snapshots.sql` must be applied through normal
operator procedures before matching server/daemon/clients. The normal release
ships binaries/artifacts; no manual publication step. No remote migrations,
deployment or host operations are performed by workers.
