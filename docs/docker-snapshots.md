# Host-local snapshots

Docker snapshots are built FROM core’s release-aware official Armada image
(`officialSandboxImage()`; source deployments use the immutable published
Armada toolchain baseline, not the dependency-free operator preview fixture).
The caller cannot select or change this base. Its exact image reference and
Armada version are frozen at admission; the version appears in dashboard and CLI
lists and in the product-written build receipt. Existing pre-version snapshots
show an unknown version, never an invented release, and remain launchable.

Snapshots are built on their registered host from the same versionable
`{repos, init}` golden JSON used for Boat/Modal. They are immutable image artifacts,
not aliases for foreign provider snapshots. Snapshot builds require GitHub access,
not a model account. The product applies host/installation, owner, visibility,
source-definition and generation labels automatically.

The host provides the checkout credential to the Docker build client through a
per-build child environment variable and an explicit BuildKit `type=env` secret.
The Dockerfile still reads only the private `github` secret mount; no token is
stored in the context, arguments, Dockerfile `ENV`/`ARG`, labels, or image. The
reserved environment variable is removed from ordinary Docker commands and the
daemon's environment is never mutated. Reopening `/dev/stdin` is not supported
by every Docker buildx client/plugin transport, so it is not used as a secret
source.

Create `armada.golden.json` locally (use repositories your GitHub connection can
access; setup runs as the unprivileged sandbox user):

```json
{
  "repos": [{ "url": "https://github.com/your-org/your-repo.git", "branch": "main", "dir": "your-repo" }],
  "init": ["cd /home/user/your-repo && bun install"]
}
```

Use setup commands appropriate to your repository and the official image. Never
put credentials in this file. The same definition can build Boat/Modal goldens,
but each provider needs its own build; their snapshots cannot be launched on a
Docker host.

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

Failed builds expose a safe `failureReason` in `armada golden get`,
`armada golden list` and the dashboard snapshot details. The host daemon logs
the snapshot ID and a fixed failure message. Raw Docker/build/init output is
not returned or logged because it can contain credentials. A failed build, an
expired build and invalidated build authorization have distinct messages;
older failed snapshots retain a generic diagnostic.

There is one active build per host and a one-hour deadline. While building, the
daemon continues ordinary mailbox work and physical TTL sweeps. Recovery adopts
only a matching already-built image; an unknown unfinished build is not replayed.
Current creator/issuer epochs and visibility authorization are checked before
credential delivery and publication. Images do not become ready on configuration
ACK alone. The trusted host operator can always read its own machine's contents.

The image includes a product-written, root-owned `/opt/armada-build/receipt.json`
with its snapshot identity, host, official base, Armada version, definition and
completed init plan. Normal
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

Migration `20261113190000_docker_snapshots.sql` must be applied through normal
operator procedures before matching server/daemon/clients. The normal release
ships binaries/artifacts; no manual publication step. No remote migrations,
deployment or host operations are performed by workers.


Migration `20261113190001_docker_snapshot_versions.sql` adds the immutable built-on
version metadata; apply it before matching server/daemon/clients. No new user
options or base-image inputs exist. The version-based rebuild offer/action is described below; nothing automatically
rebuilds or invalidates an old snapshot on upgrade. The coordinator's existing `--snapshot`
check above also requires the archived build receipt's version to match catalog
metadata; no label preparation is necessary.

## Updating an older snapshot (#1528)

Lists retain **Built on Armada** from the immutable build record. The API also
reports its current server version. For a known older stable version, dashboard
snapshot details offer **Rebuild** and CLI lists show the exact command:

```sh
armada golden rebuild SNAPSHOT_UUID --provider docker --org ORG_UUID
# After an uncertain response, repeat with the same printed --request-id UUID.
```

Rebuild reuses the saved repositories, branches, setup, visibility and original
host, with fresh caller GitHub authorization and the server's currently selected
base/version. It creates a **new** snapshot; the old snapshot and launched
sandboxes remain unchanged. Nothing rebuilds automatically. Unknown historical
versions, prereleases, equal versions or newer snapshots do not get a guessed
update offer. The CLI uses the server version, not its own installed version.

Private rebuilds require the owner; shared rebuilds require an organization
admin. The original host installation must be available for a new build. An
exact admitted retry retains its existing build even if that host later goes
offline or the server version changes. The rebuild endpoint accepts only
`org`, source `id` and a new `requestId`, never caller image/config/version fields.
Existing scan, unprivileged initialization, publication and epoch checks apply.
A failed new build does not retire the original snapshot.

### Repository history and secret scanning

Docker snapshot builds clone only the selected branch head (`--depth=1`). Init
commands can fetch additional history if needed, but the secret scan checks all
materialized files and Git objects before publishing the image, including that
extra history. This avoids importing unrelated historical credentials into a
snapshot. Token-shaped test fixtures must be assembled at runtime rather than
stored literally in source; the scan does not exempt test files. Boat and Modal
checkout behavior is unchanged.

### Normal launch preparation

Normal owner Docker launches (including snapshot launches) return their persisted
sandbox reservation promptly: `sandbox.status: "starting"`, `runtime: null`, and
no prompt receipt yet. The server's dedicated launch worker prepares the runtime,
GitHub access, repository checkout and environment before admitting the first
prompt. Replay the **identical** `sandbox/launch` request (same `requestId`) to
obtain the final prompt receipt, or inspect sandbox status for a plain failure
reason. `scripts/smoke-docker-lifecycle.py` handles both accepted and older
synchronous responses. A starting receipt is not proof that checkout succeeded.

Repository checkout uses a shallow branch clone with a bounded runtime command;
a slow clone no longer holds the launch HTTP response open. The server stores
only fixed phase diagnostics, never Git output, credentials or exception text.
Missing GitHub access becomes an authorization failure on the admitted sandbox.
Durable worker leases are renewed while preparing; another server resumes an
unfinished manifest after lease expiry (30 seconds) following a restart. Pending
launches are not ready for user prompts until preparation completes. Template
launches retain their existing synchronous admission callbacks and authorization
rechecks; this change does not move those callbacks into background work.

### Checking GitHub access

Docker repository launches use the **launching user's** connected Armada GitHub
App user access token, not the host owner's identity or the selected model
credential. The App must cover the repository and that user must have access;
Docker does not ask for a separate installation token or host-local GitHub login.
Boat/Modal managed-runtime repository preflight uses the same token resolver and
GitHub repository access check.

Sign in as that same person against the same Armada server, then run
`armada github status` to inspect connection state and installations;
`armada github connect`, `reconnect`, `install`, and `manage INSTALLATION_ID`
provide the corresponding repair flows. Status is not a per-repository access
probe, and `armada doctor` reports the connection and installation scope, but does not
probe access to a particular repository. Account-management commands require a personal login, not a service
bearer. `armada github refresh SANDBOX_ID` configures an existing sandbox; it is
not a read-only access check.

A repository-authorization failure and an unacknowledged runtime GitHub setup are
distinct. The latter reports a runtime/host delivery problem rather than telling
the user to reconnect GitHub; a duration or generic error alone cannot establish
that the stored GitHub grant is missing.

Source deployments require the same GitHub toolchain as published releases:
`git`, `gh` and `python3`. A missing release pin selects the immutable published
2.29.0 sandbox image as a toolchain baseline. Runtime and harness selection still
uses verified artifacts from the current server; the baseline is not a version
alias. The legacy `DOCKER_DEFAULT_IMAGE` remains available for explicit operator
preview APIs only. A normal launch's GitHub delivery diagnostic names the
`configureGitHub` step; it is not evidence of a missing user grant.

An accepted Docker launch can be followed immediately by `sandbox/send`. While
preparation is pending, send persists the encrypted instruction and returns an
immediate receipt with a stable public `promptId`, `status: "queued"`,
`state: "queued"`, and `conversationId: null`. No client retry loop is required.
The dedicated server worker dispatches accepted sends in order after preparation
and the prior native turn settle. Reusing the same request ID returns the original
receipt; changing its text or selected conversation is a conflict.

Status resolves the queued public prompt ID before native admission and retains
that ID when the native journal later arrives. Queue facts in logs are separate
from native journal evidence. If startup fails, the queued prompt becomes failed
with the sandbox's safe startup reason; stop/expiry/revocation fence dispatch.

Stop/delete mailbox work takes priority over queued startups and snapshot builds.
Stop intent fences queued creation/bootstrap before a physical stop ACK can
settle it. Already executing native work remains serial: cancellation does not
publish a fake stopped state or allow a late create to resurrect compute.
