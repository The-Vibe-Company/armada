# Sandbox work preservation

Armada-managed stops attempt a bounded recovery archive before removing compute.
The first version always uses encrypted server storage, even with valid GitHub
credentials: this avoids network pushes and expired-authorization failures without
changing a working branch. No remote ref is pushed or forced.

The archive contains local repository history and dirty work, not ignored files.
Archives may contain sensitive work and are encrypted with ARMADA_ENCRYPTION_KEY;
only the sandbox owner or an organization administrator can retrieve them through
`work_recovery`. Keep that encryption key available to read existing archives.

Provider-native TTL termination cannot be intercepted by this version. Armada's
lifecycle reconciler attempts preservation when it drives expiry while compute is
still available. There is no idle-stop scheduler today. Oversize, unavailable or
late capture is reported, never allowed to prevent a stop. Automatic restoration,
rescue-ref pushing and external object storage are deliberately out of scope.

## Retrieval and restore

`armada status <sandbox-id>` and `armada list` show a preservation receipt.
Use `armada recovery <sandbox-id>` (or MCP `work_recovery`) to retrieve the latest
archive as base64 JSON. MCP also accepts `recovery_id` from an earlier receipt;
subsequent stops never overwrite older archives. These are sensitive responses:
redirect to a private file, not a shared transcript. Archives are retained until
the sandbox is deleted (`armada rm <id> --yes`, API DELETE `/api/v1/sandboxes/:id`, or MCP `delete`); ordinary stop does not delete them. Deletion requires the owner or a current org admin and a stopped/failed sandbox. Managed orchestrator parents and children use their own lifecycle. Provider deletion errors or queued/pending deletion leave the row and archives intact. Retry deletion after the short activity lease (up to two minutes); do not resume a sandbox with deletion pending. Replays after completed deletion are safe.

Decode the `archive` field to a tar file. Extract only into an empty private
directory (treat paths and symlinks as untrusted). `manifest.json` maps `repo-N`
directories to original repositories. Clone `commits.bundle` for each repository,
or initialize an empty repository when `head` is null. Apply nonempty
`index.patch` with `git apply --index`, then `worktree.patch` with `git apply`;
copy `untracked/` contents into the worktree. Bundles include local refs and HEAD.
No ignored files, external LFS objects or submodule object stores are promised.

Capture requires Python 3 and git in the provider image. The archive limit is
2 MiB total; collection gets 12 seconds at the provider and a 15-second server
bound. The whole preservation attempt has a 20-second wait budget. SQL failure
may prevent recording a receipt, but never prevents stopping compute. In-flight
storage operations can finish after the wait budget. Parent orchestrator recovery
continues to use its existing fenced checkpoint protocol; child sandbox stops
use this work archive too.

Before capture Armada interrupts active turns and waits for acknowledgement under
its stop lease. Repository fingerprints before/after capture reject concurrent
writes; conflicted indexes fail closed rather than promising an unreplayable patch.
Detached/background writers outside the harness are not frozen. The collector
uses private mode-0700 temporary storage and bounded chunk reads to support the
Modal runtime's 64 KiB stdout cap. A sandbox-local janitor attempts removal after
120 seconds; a stop before then can retain these temporary files on the provider's
retained disk until resume. They never enter a golden. No cleanup exec is submitted
after stop. Modal recovery reads refuse stopped compute rather than resuming it.

OpenSSL is also required in the sandbox image. Recovery bytes are encrypted
inside the sandbox *before* any exec response: AES-256-CBC/PBKDF2 with a random
one-use password, wrapped with the server's ephemeral RSA-OAEP-SHA256 public key.
Only ciphertext enters provider command history. The server decrypts this private
transport and seals the archive with the standard AES-256-GCM storage key. The
ephemeral private key and password never enter command arguments or logs.
`armada stop` uses an extended, non-retrying transport budget for preservation.

## Incremental recovery (manifest version 2)

Capture skips hidden directories (including agent/tool caches) and node_modules.
Golden repositories live in nonhidden directories under the sandbox home.
Version 2 bundles include HEAD, local branches and tags, excluding objects already
reachable from remote-tracking refs. This keeps published history outside the
2 MiB limit. No network access is used during capture.

For version 2, first clone/fetch the original repository so the published base
commits are available, then run `git fetch /private/path/commits.bundle HEAD`
and `git checkout --detach FETCH_HEAD`. The bundle may require published
prerequisite commits; `git bundle verify` lists any missing prerequisites.
If the manifest's `bundle` is false, there are no unpublished commits: check out
the manifest's `head` in the original clone before applying patches. For an
unborn repository (`head: null`), initialize an empty repository.
Version 1 archives remain standalone and use the original instructions above.

Failures use closed receipt reasons: missing_git, missing_python3,
missing_openssl, collector_exit, collector_signal, collector_failed,
output_invalid, output_truncated, timeout, size_limit, decrypt, unavailable,
or storage. A failed attempt logs only the Armada sandbox ID and that reason,
never command output, repository paths, archive content or exception messages.

### Real sandbox validation (#759)

On the five-repository Boat golden fork, Python 3.12.3, OpenSSL 3.0.13 and
Git 2.43.0 were present. The original collector returned capture_failed with one
local commit. Full bundles measured 15.6 MB (Armada) through 219.9 MB (website),
well above the 2 MiB cap. Recursive discovery also included a hidden agent
plugin repository with unpublished history. Git's pack-objects child hit
SIGXFSZ, while the parent git command returned exit 1.

After the fix, the actual collector and encrypted chunk/decryption path succeeded
under the sandbox user using bash -c, with the real HOME and five repositories.
Each stdout response was capped at 65,536 bytes; chunks remain 32 KiB raw.
The live Boat command API could not be exercised: boat exec self returned HTTP
401 (expired session). This is local real-process evidence, not a claim of
successful remote API transport or production validation.
