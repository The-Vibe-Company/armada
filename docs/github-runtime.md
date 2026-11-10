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
in the disposable repository; never blindly repeat an ambiguous launch. Native receipts are accepted only as three bounded numeric exit codes; both
passing and failing operation codes are recorded, never arbitrary guest output.
Malformed receipts emit `invalid_receipt`. Exec Git codes are also recorded.
Cleanup first checks the exact scratch ref and reports `absent` or `deleted`;
remote-query and deletion errors remain failures. A native agent is
not a trusted attestor: these receipts prove the requested command sequence's
results, not cryptographic session or process identity.

**A zero script exit means only this automated slice passed.** Each case emits
`enablement.complete=false`: it is not permission to enable production. The
public API has no operation for forcing cached GitHub user access expiry, no
private broker lifecycle/fault control, and no native process identity attestation.
GitHub connection revocation fences the capability and requires reconnect; it is
not a safe simulation of access expiry. Do not revoke credentials, manipulate the
private socket, or copy tokens into the guest to manufacture renewal evidence.

First run `bun scripts/post-deploy-smoke.ts` with the staging server gate off
and all four cases to record the stock baseline (step 1). Retire these workers,
turn the gate on on every staging replica and run `--github-runtime` with fresh
workers. The default smoke covers stock native harness completion and exec Git;
it is not native-tool Git evidence. Use the procedures below for renewal (step 4)
and Boat broker faults (step 5). Modal's isolated broker restart is unavailable
for the architectural reason below; this is a concrete remaining #822/#825 gap,
not a sanctioned reason to kill the Runner or enable production.

Rollout order: staging gate on → automated slice **and all manual checks** green
for every provider/harness pair → coordinator enables production → authorized
read-only Git verification → rollback by turning the gate off on every replica
and retiring affected workers as described above. A partial or failed smoke blocks
this rollout. This script never deploys, applies migrations, or changes a gate.

#### Manual renewal: force server cache expiry, not GitHub revocation

**Staging operator only. Do not run this SQL on production.** This is an explicit
manual test-data mutation using the staging service role, not a migration and not
a public API. This agent has not performed it. Use the dedicated disposable smoke
identity only, with no other workers using that identity. Confirm the Supabase
project reference against the staging deployment before opening a trusted `psql`
session; provide the staging database connection through secure environment, not
command arguments or shared logs. Disable query/result tracing. Never select or
export ciphertext, refresh tokens, access tokens, or private socket replies.

Why this works: `resolveGitHubAccess` in `packages/core/src/github.ts` reuses access
only when `access_expires_at > now + 5 minutes`; otherwise it refreshes under the
owner lock and rotation CAS. `GitHubBroker.acquire` in
`packages/agent-runtime/src/github-broker.ts` calls the control plane on **every**
acquisition. It remembers leaves for redaction, but has no access-token reuse
cache. Setting the server expiry into the past therefore forces the next HTTPS
Git credential-helper invocation to refresh, even inside an existing harness.
It simulates cache expiry, not the actual passage of eight hours at GitHub.

1. The automated script cleans up its workers, so **do not use their stopped IDs**.
   For each provider/harness pair, launch a separate fresh worker with the same
   case configuration using the API-only CLI (`ARMADA_URL` and `ARMADA_TOKEN`
   remain staging values):

   ```sh
   armada launch "$GOLDEN" --org "$ORG" --provider "$PROVIDER" \
     --agent "$HARNESS" --model "$MODEL" --credential-id "$MODEL_ACCOUNT_ID" \
     --no-connections --ttl 1h --json
   ```

   Retain the returned sandbox UUID as `ID`. Send a first turn explicitly asking
   for `git status -sb` and `git ls-remote origin HEAD` in the disposable checkout,
   with stdout/stderr redirected and only numeric exit codes reported. Save its
   `conversationId` as `CONVERSATION` and `promptId`; use
   `armada wait "$ID" --org "$ORG" --prompt-id "$PROMPT_ID" --timeout 600 --json`.
   Keep this same worker and conversation throughout; never stop/resume/relaunch
   until the experiment finishes. Record server/runtime SHAs and gate assertion.
2. Record VM and native identity before expiry and after every fault/recovery.
   Through authorized exec, record `/proc/sys/kernel/random/boot_id` and native
   process PID **and start time**, not PID alone. `ps -eo pid,comm,lstart` lists
   names/times without command arguments or environment. Identify the Claude or
   Codex native process in this isolated worker, record its row, and require the
   identical PID/start time after recovery. Save the API conversation ID too.
   If the native process cannot be unambiguously identified, record identity as
   unverified and fail the continuity check; a second successful turn alone is
   not proof. Never use `ps ... args`, `/proc/*/environ`, or credential commands.
   Before the next step, admit the bounded delayed/marker-wait native remote
   operation described in step 4; it must be running before SQL expiry is forced.
3. In the **same trusted staging psql session**, substitute the smoke user's UUID
   only (not a token). Preserve the temporary table for the final comparison:

   ```sql
   \set ON_ERROR_STOP on
   \prompt 'Dedicated staging smoke user UUID: ' smoke_user
   begin;
   create temporary table smoke_github_before on commit preserve rows as
     select user_id, sha256(access_token_enc) as access_digest,
            sha256(refresh_token_enc) as refresh_digest
     from public.github_connections
     where user_id = :'smoke_user'::uuid and revoked_at is null
       and access_token_enc is not null;
   select count(*) = 1 as exactly_one from smoke_github_before \gset
   \if :exactly_one
     update public.github_connections set access_expires_at = now() - interval '1 minute'
       where user_id = :'smoke_user'::uuid;
     commit;
   \else
     rollback;
     \quit
   \endif
   ```

   Do not hold a transaction/row lock while invoking Git. Do not edit refresh
   fences, capability revisions, connection epochs, tokens, or revocation state.
4. **Before another send or exec** (which itself prepares authorization), tell
   the already-running native turn to perform the remote operation. Arrange this
   beforehand: its shell waits for a marker file in the checkout or a short,
   bounded delay, then runs remote Git and records only its numeric result.
   Release the marker through the provider's authorized out-of-band command
   console, or use the predetermined delay; do not invoke Armada send/exec between
   the SQL commit and the native remote operation. Otherwise refresh may happen
   during preparation rather than credential acquisition and the experiment does
   not prove in-harness renewal. Record the successful remote exit status.
5. Back in that psql session, emit **booleans only**:

   ```sql
   select sha256(c.access_token_enc) is distinct from b.access_digest as access_rotated,
          sha256(c.refresh_token_enc) is distinct from b.refresh_digest as refresh_rotated,
          c.access_expires_at > now() + interval '5 minutes' as expiry_advanced,
          c.revoked_at is null as still_connected
   from public.github_connections c join smoke_github_before b using (user_id);
   drop table smoke_github_before;
   ```

   Require one row, all true, successful remote Git, unchanged boot/native identity
   and conversation. Repeat exec reads and a native turn with
   `armada send "$ID" '<read-only Git prompt>' --org "$ORG" --conversation "$CONVERSATION" --json`,
   then wait for its specific prompt. Record numeric results and harness survival.
   A timeout/uncertain refresh is failure: do not restore old ciphertext or retry
   the consumed refresh. Follow the ordinary reconnect procedure for this smoke
   identity. Finally stop the worker, even on failure.

#### Manual broker fault/recovery: Boat; Modal limitation

Use a separate dedicated **Boat** smoke worker per harness, after the first native
Git turn above. The Boat broker is a detached `bun .../github-<generation>/broker.js`
process (`packages/mcp-server/src/github-boat.ts`); the harness is a different
process. Signal only that exact broker, never a native child or a process group.
Do not use a broad `pkill bun`. Preflight `pgrep -f` for the generation's exact
broker path and require **one** PID; abort on zero/multiple matches. The generation
suffix is the first 16 hex characters of SHA-256 of the boot ID, as implemented by
`configureBoatGitHub`. Read process names/PIDs only; never print arguments.

1. Admit a native turn first that waits up to 60 seconds for a marker, then runs
   local Git and remote Git with numeric-only receipts. Capture its prompt ID,
   conversation ID, boot ID and native PID/start time before injecting the fault.
2. In one authorized Boat exec, obtain the exact broker PID as above; arm an EXIT
   trap to `kill -CONT "$BROKER_PID"`. Send `kill -STOP "$BROKER_PID"`. Release
   the marker and run `timeout 5 git -C /home/user/disposable status -sb` with
   output redirected. Save its exit status; require zero. Keep the stall bounded
   (e.g. 10 seconds), then `kill -CONT "$BROKER_PID"`, disarm the trap and emit only
   numeric results. Native output may pause under redaction backpressure: that is
   expected; a native exit or changed native identity is not. Do not issue another
   Armada operation during the stall: its preparation may wait on `/configure`.
3. For broker termination/restart, admit another delayed native turn, then in one
   Boat exec send `kill -TERM "$BROKER_PID"`, release its marker, run the same
   bounded local Git check, and return. Authenticated Git may fail with a closed,
   bounded diagnostic; do not print stderr or socket responses. Now run an
   authorized `armada exec "$ID" 'true' --org "$ORG"`: the existing Boat prepare
   path reconnects, handles `ENOENT`/`ECONNREFUSED`, and recreates the broker through
   private SSH/stdin. It does **not** replace the VM or harness. Require a new
   broker PID, unchanged boot/native identity and conversation, resumed native
   output and a finished prompt. Repeat exec reads and another native Git turn
   on the recorded conversation, then stop the disposable worker. If bootstrap
   fails or any identity changes, record failure and stop; never replay commands.

**Modal does not have a separately signalable broker process.** In
`packages/agent-runtime/src/main.ts`, `new GitHubBroker`, its listener, the Journal
and `new Runner` live in the **same Bun process**. SIGSTOP stalls the control API
as well, preventing authorized exec recovery; terminating/restarting it also
replaces the Runner/session owner and is not the broker-only test required by
step 5. `configureGitHub(null)` denies acquisition but does not close the listener;
`githubSocket` is private to `main` and there is no public close/relisten operation.
Thus do **not** apply the Boat PID procedure to Modal or claim a Runner restart
as broker survival evidence. A provider-console SIGCONT could undo a whole-Runner
stall, but cannot prove isolated broker restart.

The smallest remaining guarded affordance (#825) is a staging-only, owner-authorized
Runner control operation that closes/stalls/reopens **only** `githubSocket`, re-runs
`prepareGitHubTools` with a fresh activation on reopen, preserves the Journal/native
processes, and reports fixed fault/recovery and identity labels. It must reject
production, recover automatically after a bounded interval, and expose no socket
reply/token. Until that exists, record Modal broker fault coverage as **unsupported,
not passed** and keep #822 open. This PR is partial evidence, not an enablement gate.
