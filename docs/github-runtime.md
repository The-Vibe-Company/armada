# Managed GitHub credentials in long-lived workers

GitHub App **user** access tokens expire after eight hours. Refreshing one invalidates both its
previous access token and previous refresh token. Installation tokens are different (one hour) and
are not a substitute for the worker owner's identity. See [GitHub's user-token refresh contract](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens).

## Server opt-in (default off)

The trusted server environment setting `ARMADA_GITHUB_RUNTIME_ENABLED=true` enables
this experimental runtime. Omit it (recommended), or use any value other than exact
`true`, to disable it. Restart the server after changing the setting; use the same
setting on every replica.

When off, launch, send, steer and exec do not prepare the managed GitHub runtime.
No GitHub wrapper, broker or credential socket is installed, and the internal
GitHub credential-acquisition route is not mounted. Fresh sandboxes retain stock
git/gh and the existing launch-time `GH_TOKEN`/git credential setup. This gate does
not disable GitHub OAuth, golden checkout, MCP bindings or model authentication.
The #703 implementation and migration `20261110121300_github_runtime.sql` remain.

**Existing-worker limitation:** disabling the server setting does not undo files
already installed inside a worker while it was enabled, stop its broker, or restore
its binaries. Its managed credential acquisitions will fail once all replicas are
off, so git/gh may still fail there. Do not treat this switch as an in-place repair:
retire affected workers through the normal lifecycle and launch replacements from
a clean golden that has never had managed wrappers installed. Do not snapshot an
affected worker into a golden. No automatic command replay or guest mutation is
performed by the off path. Root-cause repair and automated restoration are separate work.

The sections below describe the opt-in path only.

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

The #719 repair separates ordinary Git execution from credential acquisition: ordinary
Git runs directly as the caller, with inherited GitHub token variables removed; HTTPS
Git asks the installed helper for authorization only when needed. Explicit `git credential` output (including Git aliases) and arbitrary shell aliases
remain supervised so `credential fill` does not publish managed token bytes.
Like stock Git, ordinary local Git output is not an arbitrary-secret redaction boundary.
Native harness output and gh output retain broker redaction. Native output is held with
pipe backpressure while the redactor is unavailable, not forwarded unfiltered and not
used as a reason to terminate the harness. This can pause visible turn output until
recovery; it does not provide uninterrupted output during a total redactor outage.
Diagnostics expose only fixed stage/reason labels, never exception text, socket paths,
credential responses or environment values. A missing socket reports `socket_missing`;
permission errors, refused connections and timeouts have distinct labels.

### Automated first slice (#822)

Run `bun scripts/post-deploy-smoke.ts --github-runtime` from a trusted checkout.
This **staging-only, billable** mode shares the API transport, deadlines and cleanup
of [post-deploy smoke](post-deploy-smoke.md). It does not enable the server gate.
In addition to that page's `ARMADA_URL`, `ARMADA_TOKEN`, `ARMADA_SMOKE` and
`ARMADA_SMOKE_CASES`, set:

- Railway staging server: `ARMADA_GITHUB_RUNTIME_ENABLED=true` on every replica;
  restart with the reviewed runtime artifacts. Never change production for this test.
- Operator shell: `ARMADA_SMOKE_GITHUB_GATE=true` (an assertion, not remote detection).
- `ARMADA_SMOKE_SERVER_REVISION` and `ARMADA_SMOKE_RUNTIME_REVISION`: the deployed
  full 40-character lowercase Git SHAs, obtained from deployment/build records.
  Evidence labels these **operator asserted**, not server-attested.
- Each case: `disposableRepository` set to the exact credential-free HTTPS origin
  URL, e.g. `https://github.com/your-org/disposable-runtime-smoke.git`. Use a
  dedicated, disposable repository and smoke identity with push permission. The
  persisted golden must authorize this repository and its checkout must already
  have this exact origin. Include all four Boat/Modal × Claude/Codex pairs.

The mode checks origin equality before asking the first native turn to run local
Git, remote Git and a push of existing HEAD to a UUID scratch branch. It checks a
private run-specific numeric receipt via exec, runs both read commands via exec,
then repeats both in a second native turn. No commit or checkout is changed.
Finally it attempts scratch deletion before stopping the sandbox, even on failure.
A failed/ambiguous push or cleanup requires inspecting the reported scratch branch
in the disposable repository; never blindly repeat an ambiguous launch. Failed
receipt checks expose only a closed error, never guest output. A native agent is
not a trusted attestor: these receipts prove the requested command sequence's
results, not cryptographic session or process identity.

**A zero script exit means only this automated slice passed.** Each case emits
`enablement.complete=false`: it is not permission to enable production. The
public API has no operation for forcing cached GitHub user access expiry, no
private broker lifecycle/fault control, and no native process identity attestation.
GitHub connection revocation fences the capability and requires reconnect; it is
not a safe simulation of access expiry. Do not revoke credentials, manipulate the
private socket, or copy tokens into the guest to manufacture renewal evidence.

The operator must still record the gate-off stock baseline (checklist step 1),
actual token expiry/renewal in the same VM/native session (step 4), broker
stop/stall/restart plus local-Git usability and harness survival/recovery (step 5),
and the exact identity/exit-status evidence missing from this slice. Follow-up
#825 tracks the smallest guarded non-production controls and automated continuity
evidence. Until then these remain manual checklist steps and block enablement.

Rollout order: staging gate on → automated slice **and all manual checks** green
for every provider/harness pair → coordinator enables production → authorized
read-only Git verification → rollback by turning the gate off on every replica
and retiring affected workers as described above. A partial or failed smoke blocks
this rollout. This script never deploys, applies migrations, or changes a gate.
