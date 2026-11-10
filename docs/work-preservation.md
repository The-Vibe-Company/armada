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
the sandbox metadata is deleted; ordinary stop does not delete them.

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
