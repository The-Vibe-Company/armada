# Managed GitHub credentials in long-lived workers

GitHub App **user** access tokens expire after eight hours. Refreshing one invalidates both its
previous access token and previous refresh token. Installation tokens are different (one hour) and
are not a substitute for the worker owner's identity. See [GitHub's user-token refresh contract](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens).

## Credential-time renewal

Launch/prompt preparation and authorized exec/steer prepare a GitHub-only broker in the **same VM**.
A pre-existing native harness is not restarted: subsequent gh/git commands reach managed executable
wrappers, including the standard absolute executable paths. Original binaries are preserved once.
The wrapper clears inherited `GH_TOKEN`/`GITHUB_TOKEN` instead of assuming a parent environment update
can change a running child. Git's HTTPS credential-helper reply is private IPC to Git. gh receives
current access material in its child environment. No owner refresh token, App client secret, signing
key, manager PAT, database credential or general vault API is installed in the guest.

The private control operation acknowledges configuration only. Access bytes never appear in an
ordinary Runner response, request receipt, event or public DTO. The awaited GitHub-only acquisition
response uses a sandbox capability over HTTPS, then a root-only Unix credential socket. That socket
starts inactive and is activated with a one-use private key only after the privileged installer has
set root ownership. The guest-readable socket offers redaction/register-ACK only, never raw secret
listing or acquisition. Tokens are registered
synchronously before the local reply or command execution. Tool output is filtered before it reaches
an existing harness, so `gh auth token` and an explicit `git credential fill` cannot print managed
material into native command logs. Registration is append-only for current and retired leaves;
backend-encrypted per-physical-generation issuance history restores redaction after broker restart.
Inherited launch tokens are registered before a wrapper uses them. Previously issued access material
is not replaced by a later parent environment variable.

Modal uses the existing authenticated Runner control transport and Journal registry. Boat bootstrap
uses the existing pinned SSH/stdin transport, not Provider.exec or credential-bearing argv. A private
broker process holds its GitHub-only Journal registry in memory; the supervised wrappers request
redaction before forwarding output. The existing noninteractive sudo policy installs/supervises the
gh/git helpers, and their actual command child drops back to the worker UID. Future Boat Claude and
Codex parent wrappers also redact arbitrary stdout/stderr via the safe redaction-only channel. Model native-auth publication, exclusive-writer and checkpoint ACK rules
remain separate and unchanged. GitHub acquisition is not an async callback passed into the synchronous
model `refreshNativeSecrets` hook. Epoch install/scrub remains a distinct quiescent operation.

## Authority and races

The server derives the original sandbox owner and organization from SQL. A capability pins provider,
backend, physical generation, immutable Modal workspace/environment/App, owner membership epoch,
GitHub connection epoch, source golden and allowed repositories. No guest owner/provider/App override
is accepted. SQL independently checks active membership, resource identity, lifecycle/deadline,
connection revocation and repository/operation authority before and after resolving the token. An
activity lifecycle counter is sampled per acquisition; it is **not** relabeled as a physical runtime
epoch. Stop/delete/removal/reconnect and physical replacement invalidate old capabilities. A same-boot
Boat resume explicitly fences old GitHub capabilities before resume.

A purpose-derived capability remains stable for the same authorized binding; access rotation does
not invalidate another worker's binding. Each configuration has a database-monotonic revision. Late installations cannot overwrite a newer
configuration, and a scrubbed revision cannot resurrect itself. Late acquisitions register any
received leaf for redaction but cannot publish it across configuration replacement or expiry.

Owner refreshes retain the per-user lock and rotation CAS. A durable pre-request consumed fence
prevents replay after an uncertain HTTP/SQL outcome. Production uses a separate small autocommit pool
for that fence: owner transactions cannot starve the connection needed to persist consumption. The
minimal SQL adapter fallback uses the atomic consumed-fence CAS without holding an unsupported owner
transaction. An uncertain outcome is unavailable and requires reconnect; no blind refresh or command
replay is attempted. An explicit cached-access 401 can refresh once under the owner lock; outages do
not trigger that access-rejection retry. Concurrent workers reuse the latest cached owner material,
not one frozen access token per VM.

Acquisition is limited to repositories in the persisted golden and gh/git operations. It does not
cryptographically attenuate a GitHub user token beyond GitHub's App/user permissions. Owner/admin
**guest exec** inherently can observe guest-resident capabilities; that does not grant control-plane
refresh/vault access or a personal-credential listing API. Arbitrary non-GitHub hosts and direct
`gh api graphql` are refused by the managed CLI boundary; ordinary gh PR/issue commands may use their
native GraphQL implementation. General long-running gh invocations already executing with an old
child environment are not transparently replayed; future invocations acquire fresh material.

## Deployment and validation

1. Apply the new `20261110121300_github_runtime.sql` migration before compatible server deployment.
   It adds only service-role GitHub capabilities, encrypted issued leaves and consumed-refresh fences,
   plus a reconnect/revocation epoch. No applied migration is edited. It is unrelated to model-auth203.
2. Keep the existing `ARMADA_ENCRYPTION_KEY` and GitHub App OAuth configuration. Boat requires the
   existing pinned SSH bootstrap prerequisites: Node, Bun, Python3, Git, and noninteractive privileged
   tool installation. gh may be absent; Git credential renewal still works.
3. Build the pinned runtime artifacts (`bun packages/agent-runtime/build.ts`) and validate them.
   The server binary embeds the Boat broker artifact; no source checkout is required remotely.
4. Tests are offline. The process fixture uses actual gh and Git from an already-running shell;
   SQL policy tests use the real migrations; the existing PostgreSQL CI job proves autonomous commit,
   owner isolation and single rotation. The existing CI-owned OS fixture also executes actual pinned
   SSH bootstrap, private stdin, installer revisions and redaction without a provider API. No live consent, token rotation or provider action is a test.
5. After deployment, the integrator may use an already-owned worker for reviewed read-only `gh api
   user` and `git ls-remote` checks from an authorized repository directory (or set `GH_REPO`). An authorized exec prepares the private broker without replacing
   the VM or native session. Do not allocate/restart a VM or copy manager credentials as a workaround.

### Incident #719: enablement smoke checklist

Do not enable the managed runtime until the default-off server gate from #718 is merged
and the runtime repair in #719 passes process-level regression coverage. A successful
broker bootstrap or an isolated `gh auth status` is not sufficient evidence: neither
exercises Git inside a native harness process tree.

Before enabling it for general use, an authorized operator must run this smoke in a
non-production environment with disposable repositories and credentials:

1. With the setting off, launch both Claude and Codex and confirm stock Git/gh behavior.
2. With the setting on, launch a fresh sandbox for each harness. In the first turn run
   `git status -sb`, `git ls-remote origin HEAD`, and a push to a uniquely named scratch
   branch in an explicitly authorized disposable repository.
3. Run `git status -sb` and `git ls-remote origin HEAD` through authorized exec, then
   run them again in a second agent turn. Confirm the original harness remains usable.
4. Exercise access-token expiry/renewal without replacing the VM or native session;
   repeat the remote operation and verify it uses renewed authorization.
5. Stop, stall, and restart the private broker. Local Git must continue to work;
   authenticated network operations may fail with a sanitized, bounded error, but
   neither harness may exit. Repeat exec and a second turn after recovery.
6. Remove scratch branches and stop disposable sandboxes. Do not copy personal or
   manager credentials into the guest, print tokens, or enable production as a test.

Record the server/runtime revision, gate setting, provider, harness, operation exit
statuses, renewal outcome, and harness survival. Keep token values and private socket
responses out of the evidence. A failure in either harness blocks enablement.
