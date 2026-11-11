# Private Skillpack installation

Skillpack automation uses a separate workspace-bound personal access token:
`cmp_pat_` followed by 48 lowercase hexadecimal digits (24 random bytes).
The native service defaults to a 90-day lifetime and refuses a longer lifetime;
revocation or membership loss may invalidate it sooner. Never reuse Armada,
provider or GitHub authority as Skillpack authentication.

Native private references are bare slugs inside the key's
workspace. `org/slug` is always anonymous catalog lookup, even when a key is
present. An exact `--version` is required for Armada installations.

Security boundary: the server, native CLI, SSH and provider host are trusted.
Installed skills can read their sandbox's files and later harness credentials
or delegated authority; they must not inherit the installation key. Existing
hostile guest processes and provider administrators can observe live process
environments: command-local injection is not protection against those actors.
Do not install a private package into an already hostile sandbox.

## Configure and install

Create a Skillpack key scoped **only to `skills:read`**. Armada refuses broader
or unknown scopes before installing. Native CLI presently does not enforce its
`--confirm-secrets` flag; scope restriction is the actual security fence. Human
login keys default to broad capabilities and must not be used here.

Use `armada creds set skillpack --file <private-file>` or pipe the value on
stdin. Add `--org <organization>` for an org default (admin only). Your own
credential wins over the org's, and a refused personal key never silently falls
back to wider org authority. Storage uses the existing AES-GCM encrypted vault;
a user JWT cannot read `value_enc`. The value is never an argument.

Orchestrator create accepts `--skill notes@1.0.0`. It resolves the key only after normal owner/org authorization and
installs before delegated authority or the first turn. Qualified references
remain anonymous; the private key is not resolved or sent for those installs.
The receipt records the exact reference, version, skill UUID, checksum and fixed
origin plus the authenticated `workspaceId` (public receipts omit this field).
Missing key, refused key, unavailable/inaccessible skill, and general
installation failure have separate closed diagnostic reasons. Provider/tool
output is never forwarded.

The server-only `installPrivateSkill` function is the shared integration point
for #867's launch/golden work, not a second provider environment mechanism.
Those call sites are not present on main yet. Golden callers must install before
the existing snapshot scan; its PAT pattern now includes Skillpack tokens. This
PR does not add golden skill configuration or ordinary launch flags.

Transport uses pinned-host SSH stdin. The key is passed only in child process
environment to `skillpack auth status` and `skillpack install`, then discarded;
no `auth login`, profile write, argv secret or provider command journal is used.
The freshly authorized SSH key is removed under the shared `authorized_keys`
lock **before** the installer runs, including on refused/missing-skill paths;
unrelated keys and file metadata are preserved. Golden create/update installs the trusted native CLI automatically; the base
image must supply Node, Bash and `flock`. Private secret
projection is denied by the required read-only capability set: skills requiring
secret projection fail at the API authorization boundary, before projection.

Defaults, version resolution, custom origins and secret-bearing skill packages
are outside this first credential/install slice. No live credential or production
install is used in verification; fake SSH/CLI tests execute the actual guest
script and check receipt validation, error sanitization and command-local auth.

## Required post-merge staging check (not run by this PR)

Run **`private-skillpack-staging-boat-modal`** on the deployed **staging** server
only, once for Boat Codex and once for Modal Codex, after its normal approved
migration/deployment. This is a coordinator check, not a claim of real-provider
verification. Do not run it in production. Keep #841 open: defaults and optional
version resolution with durable pins remain undone; #867 consumes this hook.

Prerequisites: staging Armada session, authorized model account for each provider,
a staging golden for each provider with the trusted native Skillpack binary,
Node, Python 3 and `flock`; one private slug/version that has no secret bindings,
its expected workspace UUID and package checksum from Skillpack. Prepare separate
read-only (`skills:read` only) and broad-scope staging PAT files privately, never
in argv or shell history. Use disposable goldens containing a pre-authorized audit
SSH identity. `$AUDIT_SSH_CONFIG` must pin host keys and select that identity;
`boat-golden`, `modal-golden`, `boat-parent`, `modal-parent` are operator-configured
SSH aliases for those exact staging resources. Point the parent aliases at the
new provider machine after correlating its Armada sandbox UUID with the staging
provider resource; do not call `provider.sshKey` just to audit, since that itself
adds an authorization. Modal's parent audit must exercise the root SSH login.

Set `ARMADA_URL` to the staging origin. For **each** `PLACEMENT=boat` and
`PLACEMENT=modal`, supply that provider's `GOLDEN_ID`, `MODEL_ACCOUNT_ID`, `MODEL`,
`PROJECT_DIR`, and the private `SKILL_SLUG`, `SKILL_VERSION`, `WORKSPACE_ID`,
`PACKAGE_CHECKSUM`, `SKILLPACK_READ_FILE`, `SKILLPACK_BROAD_FILE`:

```bash
set -euo pipefail
PATTERN=$(bun -e 'import {SKILLPACK_TOKEN_PATTERN} from "./packages/core/src/skillpack-token.ts"; console.log(SKILLPACK_TOKEN_PATTERN)')
armada orchestrator capabilities --json  # both requested staging pairs must be enabled
armada creds set skillpack --file "$SKILLPACK_READ_FILE"
armada orchestrator create "private-skillpack-${PLACEMENT}-$(date +%s)" \
  --org "$ORG_ID" --golden "$GOLDEN_ID" --provider "$PLACEMENT" --agent codex \
  --model "$MODEL" --model-account "$MODEL_ACCOUNT_ID" \
  --skill "$SKILL_SLUG@$SKILL_VERSION" --idempotency-key "$(uuidgen)" --json > /tmp/skill-create.json
ID=$(jq -r .orchestratorId /tmp/skill-create.json)
# Poll (at most 5 minutes); fail on blocked/archived rather than assuming create admission is success.
deadline=$((SECONDS+300))
while :; do
  armada orchestrator detail "$ID" --org "$ORG_ID" --json > /tmp/skill-detail.json
  state=$(jq -r .orchestrator.state /tmp/skill-detail.json)
  [ "$state" != blocked ] && [ "$state" != archived ]
  [ "$state" != ready ] || break
  [ "$SECONDS" -lt "$deadline" ]; sleep 1
done
jq -e --arg ref "$SKILL_SLUG@$SKILL_VERSION" --arg ver "$SKILL_VERSION" \
  --arg workspace "$WORKSPACE_ID" --arg checksum "$PACKAGE_CHECKSUM" \
  '.orchestrator.skillReceipt | .reference==$ref and .version==$ver and
   .workspaceId==$workspace and .checksum==$checksum and
   .origin=="https://skillpack.app/v1" and (.skillId|type)=="string"' /tmp/skill-detail.json
REV=$(jq -r .orchestrator.revision /tmp/skill-detail.json)
armada orchestrator send "$ID" "Read the installed $SKILL_SLUG SKILL.md and return its known staging marker only; do not display credentials." \
  --org "$ORG_ID" --expected-revision "$REV" --idempotency-key "$(uuidgen)" --json
armada orchestrator events "$ID" --org "$ORG_ID" --all --json
```

Expected: create reaches `ready`, receipt exactly matches the private pin and
workspace, first-turn events identify the known marker from the installed file
(no missing skill or setup error). Native real `auth status`/lock formats and
root uid/gid installation are exercised by this success, not assumed from fakes.

**Absence and key-authorization audit:** before create, run the following key
fingerprint command through the **golden** alias; after install run it through
the **parent** alias. Require identical output (only public-file hashes, no key
contents). Run as root, using `sudo -n` only when the audit login is unprivileged:

```bash
# Execute this remote command on both "$PLACEMENT-golden" and "$PLACEMENT-parent":
ssh -F "$AUDIT_SSH_CONFIG" "$PLACEMENT-golden" \
  'if [ "$(id -u)" = 0 ]; then exec sh -c '\''for h in /home/user /root; do if [ -f "$h/.ssh/authorized_keys" ]; then sha256sum "$h/.ssh/authorized_keys"; else echo "absent $h"; fi; done'\''; else exec sudo -n sh -c '\''for h in /home/user /root; do if [ -f "$h/.ssh/authorized_keys" ]; then sha256sum "$h/.ssh/authorized_keys"; else echo "absent $h"; fi; done'\''; fi' > "/tmp/$PLACEMENT-keys-before.txt"
# Repeat the same remote command with alias "$PLACEMENT-parent" and output
# "/tmp/$PLACEMENT-keys-after.txt", then:
diff -u "/tmp/$PLACEMENT-keys-before.txt" "/tmp/$PLACEMENT-keys-after.txt"
```

For both successful and refused parents, run this scan over the already pinned
parent audit connection **after the install command has exited**. It prints only
fixed status labels, never matched bytes. It checks process environments,
Skillpack state/projections, histories, project state, and Modal's actual native
exec/event journal (including SQLite WAL) under `.armada-runtime`:

```bash
AUDIT_ARGS=$(printf ' %q' "$PATTERN" "$PROJECT_DIR")
ssh -F "$AUDIT_SSH_CONFIG" "$PLACEMENT-parent" \
  "if [ \"\$(id -u)\" = 0 ]; then exec python3 -$AUDIT_ARGS; else exec sudo -n python3 -$AUDIT_ARGS; fi" <<'PY'
import glob, os, re, sys
pattern = re.compile(sys.argv[1].encode())
def check(path):
    try:
        with open(path, 'rb') as f:
            tail = b''
            while chunk := f.read(65536):
                chunk = tail + chunk
                if pattern.search(chunk):
                    raise RuntimeError('Skillpack credential persisted')
                tail = chunk[-256:]
    except (FileNotFoundError, ProcessLookupError):
        pass  # process exited while inspecting /proc
try:
    for p in glob.glob('/proc/[0-9]*/environ'): check(p)
    for home in ['/home/user', '/root']:
        for name in ['.bash_history', '.zsh_history', '.config/fish/fish_history']:
            check(os.path.join(home, name))
        for name in ['.companion', '.config/skillpack', '.armada-runtime']:
            for root, _, files in os.walk(os.path.join(home, name), followlinks=False):
                for name in files: check(os.path.join(root, name))
    for root, _, files in os.walk(sys.argv[2], followlinks=False):
        for name in files: check(os.path.join(root, name))
except Exception:
    print('FAIL private Skillpack credential absence audit'); sys.exit(1)
print('PASS private Skillpack credential absence audit')
PY
```

Expected: `PASS` and zero key diff, including on Modal root. An unreadable existing
file/process is a failed check, not proof of absence. No matching values or raw
journal may be printed or saved. For Boat, additionally scan the provider-side
exec journal, since SSH itself intentionally does not enter that journal:

```bash
# BOAT_ID is the exact parent provider ID, not the Armada sandbox UUID.
# Fresh staging parent must have fewer than 100 commands; otherwise page the full journal.
SCAN='import re,sys; assert not re.search(sys.argv[1].encode(),sys.stdin.buffer.read()), "FAIL provider journal credential"; print("PASS provider journal credential")'
boat history "$BOAT_ID" --mode commands --limit 100 --json | python3 -c "$SCAN" "$PATTERN"
for cmd in $(boat history "$BOAT_ID" --mode commands --limit 100 --json | jq -r '..|objects|.id? // empty|select(startswith("cmd_"))'); do
  boat history "$BOAT_ID" "$cmd" --json
  boat history "$BOAT_ID" "$cmd" --stderr --json
done | python3 -c "$SCAN" "$PATTERN"
```

**Broad-key refusal:** replace the personal key using
`armada creds set skillpack --file "$SKILLPACK_BROAD_FILE"`, repeat create with a
new name/idempotency key on each provider and poll detail until `blocked`.
Expected: `.orchestrator.blockedReason` **and** the create operation's `.errorCode`
are `skillpack_credential_refused`, `.orchestrator.skillReceipt` is null, and
there is no conversation/first prompt. Run the same absence/key/journal checks
on this parent's audit alias. Restore the read-only key from its private file.
Also repeat with a known nonexistent private slug: expect
`skillpack_skill_unavailable` and no receipt/first turn. No key is ever an argv
value, output value, fixture or log.

After recording only sanitized receipt/status/check results, stop each disposable
parent with `armada orchestrator stop "$ID" --org "$ORG_ID" --expected-revision
"$REV" --idempotency-key "$(uuidgen)" --json` using a fresh detail revision, and
retire staging resources through the normal operator cleanup. Do not claim this
check passed until both providers and both key-scope cases actually pass.

## Diagnosing a failed create

A golden used for private skills must contain the trusted released **native**
Skillpack executable on the SSH user's PATH, plus Node, Bash and `flock`.
A pre-Skillpack golden is not upgraded automatically: rebuild it with
`armada golden update` as below (the command also scans and snapshots it).
Before snapshotting, run `command -v skillpack node bash flock` and
`skillpack --version` as the guest user. Do not use `auth login` in a golden or
snapshot a credential. Check private access using a disposable sandbox and a
command-local, stdin-supplied `skills:read`-only key; never print auth status or
raw install output into a shared log.

Coordinator staging evidence confirmed the #897 cause: `smoke-modal` was built
before private skills support and `skillpack` was absent from the SSH user's PATH.
Node v22.23.4, Bash and `flock` were present. Authentication was never reached;
key scope remains unverified. This now returns `skillpack_cli_unavailable` at
`skills_auth`, directing the owner to rebuild the golden. The failed operation
settles as `failed`; the parent becomes `stopped` only after confirmed cleanup.

Closed reasons and corrective actions (API operation `errorCode`, event operation
receipt and server diagnostics use the same codes):

| Reason | Action |
| --- | --- |
| `skillpack_credential_missing` | Store a personal or org Skillpack credential. |
| `skillpack_credential_refused` | Replace an expired/revoked key; check workspace membership. |
| `skillpack_scope_refused` | Replace the key with one scoped **only** to `skills:read`. |
| `skillpack_download_unavailable` | The last golden build could not download Skillpack. Allow GitHub release HTTPS egress, then rebuild; repeating offline builds will not help. |
| `skillpack_cli_unavailable` | Rebuild the golden with the trusted native CLI executable on PATH; check its permissions/version. |
| `skillpack_auth_unavailable` | Check registry connectivity and CLI/API compatibility during auth status. |
| `skillpack_protocol_invalid` | Update the trusted native CLI/API; auth status did not return the supported workspace contract. |
| `skillpack_skill_unavailable` | Check the bare slug, exact version and key's workspace access; secret-projecting skills are not supported. |
| `skillpack_install_conflict` | Inspect project lock/install state in a disposable sandbox; rebuild a clean golden. |
| `skillpack_request_rejected` | Check the requested version/tool and update CLI/API compatibility. |
| `skillpack_registry_unavailable` | Check registry/network availability, then create with a new idempotency key. |
| `skillpack_timeout` | Check guest resources and registry connectivity; inspect before retrying. |
| `skillpack_receipt_invalid` | Rebuild with a compatible native CLI; inspect project permissions and lockfile without exposing package contents. |
| `skillpack_transport_failed` | Public install provider-exec transport failed: check provider command availability/liveness. Private SSH uses the precise #914 sub-step reasons below. |
| `skillpack_credential_unreadable` | Re-store the personal/org key with `armada creds set skillpack --file <private-file>`; check server encryption-key configuration if this persists. |
| `skillpack_process_failed` | Check guest process limits and CLI execution resources; no registry response was obtained. |
| `skillpack_install_nonzero` | The native installer exited with an unsupported status; check CLI version/permissions and report the closed install-stage reason. |
| `skillpack_install_state_invalid` | Check project directory permissions and native CLI compatibility; installation could not produce supported state. |

Diagnostics distinguish `skills_credential` (stored-key resolution/validation), `skills_auth`, `skills_install`, `skills_receipt` and
`skills_transport`. A private installation error settles the operation as
`failed`, never `uncertain`: no delegated authority or conversation has started.
Create attempts stop the failed allocation and publish `stopped` only after the
provider confirms it. If cleanup cannot be confirmed, the parent remains
`blocked` for explicit owner cleanup; the original failure reason is preserved.
A new create needs a new idempotency key; replay returns the failed receipt.

## Automatic provisioning and rebuilding smoke-modal

Golden create **and update** provision native Skillpack **0.3.5** before user init
and the secret scan. Armada downloads the official versioned Linux x64/arm64
archive over HTTPS, verifies the platform SHA-256 pinned in
`packages/core/src/golden-skillpack.ts`, then extracts it and self-tests both
native binaries. No downloaded installer shell is executed. A checksum mismatch,
invalid archive or failed version/help self-test **fails** the build with
`failureReason: skillpack_integrity_failed`; the old golden remains unchanged.

An unreachable release download is the only provisioning failure that is soft.
The build can succeed for non-skill use, but its result has
`warnings: ["skillpack_download_unavailable"]`. The same snapshot-bound metadata
is persisted as `goldens.build_warnings`, visible in golden API/list output,
CLI create/update warnings, build-status JSON and the dashboard golden row and
expanded panel. This is not only a server log. Allow HTTPS egress to github.com
and release-asset hosts **before** rebuilding; repeating an offline build is not
a remedy. A later missing-CLI error from that golden reports
`skillpack_download_unavailable` and the last build's network problem rather
than blindly asking for another rebuild. A successful clean rebuild clears the
warning. Old goldens with no warning history still report `skillpack_cli_unavailable`.

The managed executable is linked through `/usr/local/bin/skillpack` when writable
or passwordless sudo is available. Otherwise the build retains its user-local
executable and reports informational `skillpack_user_local_only`; both public and
private skill installs discover `/home/user/.local/bin`. Root builds normalize
ownership before the worker runs. No login or Skillpack key is used in building.

### Deployment prerequisite

Apply **20261110210000_golden_build_warnings.sql** before deploying this server or
dashboard revision. It adds only closed server-written metadata to existing
rows/jobs (empty defaults), no secret or user-write grant. Deploying the old code
again leaves the additive metadata harmless; do not drop columns while new code
is running. No migration or deployment was performed by this PR workflow.

After the coordinator makes this server revision available on **staging** (not
production), use the staging Armada origin/session and an org admin account.
Preserve the existing repositories, branches, directory names and init steps:

```sh
STAGING_ORG='<staging org id or name>'
armada golden list --provider modal --json > /tmp/staging-goldens.json
jq -e '[.[] | select(.id == "33a32ddc-1e48-48af-83d0-e65398674674" and .name == "smoke-modal" and .provider == "modal")]
  | if length == 1 then .[0].config else error("expected smoke-modal golden missing or ambiguous") end' \
  /tmp/staging-goldens.json > /tmp/smoke-modal.golden.json
armada golden update smoke-modal --org "$STAGING_ORG" --provider modal \
  --config /tmp/smoke-modal.golden.json --timeout 600
```

Do not resubmit an admitted build if local polling ends: use the printed job ID
with `armada golden build-status <job-id>` until `succeeded`. Update replaces the
snapshot pointer in place, retaining the golden ID/provider binding/visibility;
do not use `golden snapshot` on the old master. Files or setup performed by hand
on an old golden are not part of its persisted config: reapply any required
non-secret custom setup with `--setup <local-script>` during update.

Then rerun the original `orchestrator create` with a fresh name/idempotency key,
the same golden ID and `--skill ship-pr-dev@1.6.1`. The personal Skillpack key must
be scoped **only** to `skills:read`; broad keys now return
`skillpack_scope_refused`. Confirm the build result has no `skillpack_download_unavailable` warning and the worker can run `command -v skillpack` before retrying. Confirm a non-null skill receipt and a ready parent.
Send only closed stage/reason if it fails, not raw auth status or a key value.

The public sandbox-launch path now reports the same closed missing-CLI reason
and `golden update` action, with distinct request/package/registry/receipt/transport
classifications. It discovers the user-local executable too. Native install-stage
usage exit (2) is `skillpack_request_rejected`, not a missing CLI; auth-status
usage exit (2) signals an incompatible CLI.

## Private SSH transport diagnostics (#914)

Boat supplies a provider-pinned endpoint and user identity. Modal authorizes an
Ed25519 key via its SDK, starts port 2222 behind a TCP tunnel and returns the
actual host key: workers log in as `user`, golden builders as `root`. Do not
switch workers to root or disable host-key checking. Modal's provider-managed
SSH authorizations live in `/run/armada-ssh` and expire after 15 minutes, not in
`~/.ssh`; the server's ephemeral private key is always destroyed after the
exchange. The home-key cleanup script must not be mistaken for proof that this
separate root-owned provider store was edited.

Private installs now log a closed sub-step reason at `skills_transport`, never
raw SSH stderr, credentials, endpoint details or the SDK exception:

| Reason | Action |
| --- | --- |
| `skillpack_ssh_local_storage_failed` | Check server ephemeral directory/file permissions and cleanup; the transport could not manage its local SSH material. |
| `skillpack_ssh_keygen_failed` | Check server ephemeral storage and `ssh-keygen` availability/permissions. |
| `skillpack_ssh_authorization_failed` | Check provider key registration and active sandbox lifecycle; the guest was not reached. |
| `skillpack_ssh_connection_failed` | SSH exited 255 without a more specific classification, or failed during key exchange/closed the connection. Check the Modal TCP tunnel and whether sshd is serving port 2222; this is not proof the guest command ran. |
| `skillpack_ssh_connection_invalid` | Check provider-returned SSH username, endpoint and pinned host-key metadata. |
| `skillpack_ssh_host_key_rejected` | Reconcile the provider's actual host key; do not disable pinning. |
| `skillpack_ssh_authentication_failed` | Check provider authorization, worker user and key expiry. |
| `skillpack_ssh_unreachable` | Check the provider tunnel and server egress to its SSH port. |
| `skillpack_ssh_timeout` | Check SSH liveness and guest command completion. |
| `skillpack_ssh_node_missing` | Rebuild with Node on the SSH user's PATH. |
| `skillpack_ssh_flock_missing` | Rebuild with `flock` on the SSH user's PATH. |
| `skillpack_ssh_home_unavailable` | Repair the worker home directory and traversal permissions. |
| `skillpack_ssh_key_cleanup_failed` | Check the worker's `.ssh` directory and cleanup lock ownership; no private install ran. |
| `skillpack_ssh_remote_failed` | The remote command failed without an accepted protocol marker; check guest shell prerequisites without forwarding raw output. |
| `skillpack_ssh_output_invalid` | The private response was malformed, oversized or not a supported receipt; inspect guest startup-output pollution without sharing it. |

Tests previously substituted both SSH executables and guest home paths, so they
did not prove a real Modal worker SSH session. A local disposable Docker check
with the actual Modal SSH preparation and NNP can reach private CLI scope
validation as a non-root worker; this does not substitute for a staging rerun.
The staging cause in #914 is not inferred from that local check.

A failed private **create**, before authority installation or a conversation,
disposes its fresh Modal allocation instead of attempting a native checkpoint.
Only an acknowledged `deleted` receipt produces a terminal `stopped` parent and
a deleted sandbox row. Pending/failed disposal remains visibly blocked with the
original install reason; do not claim a terminal outcome without physical proof.
Boat retains its confirmed-stop path. Existing conversations and resumes are
never discarded by this cleanup path.

The #914 investigation also found a concrete namespace mismatch: the initial
orchestrator provider was resolved from the org golden, but the sandbox row was
persisted private. Modal store namespaces include visibility. Re-resolving that
sandbox for cleanup therefore selected a different store. New creates now bind
the private working target from the outset, while retaining the original golden
visibility for source credentials/App authority. Recovery already uses this
split-source contract. The old scope-free provider fake hid the mismatch; the existing
production resolver integration test now checks both working-target privacy and
source authority at the factory boundary.

This fixes new creates, not historical stranded allocations. Do not introduce a
cross-scope fallback or delete older resources by name: use exact, fenced create
recovery/management proof. The namespace mismatch explains failed cleanup, not
the original live SSH failure; the staging transport sub-step still needs proof.

Failed-create cleanup emits exactly one additional secret-free
`orchestrator_create_cleanup_failure` record if it cannot confirm cleanup. Its
closed `step` is `fence`, `resolve`, `revalidate`, `delete`, `stop` or `unconfirmed`.
Its `reason` is the existing safe error-class vocabulary (or `cleanup_unconfirmed`
when no deletion/stop receipt proves completion), never the exception message.
The original install reason remains the operation errorCode/parent blockedReason;
cleanup exceptions and provider messages are never forwarded. A pending delete
is `unconfirmed`, not proof of deletion or grounds to publish a terminal parent.

If Node/flock is absent, those prerequisite checks necessarily run before home-key
cleanup. Boat can retain that ephemeral public authorization until owner cleanup;
Modal authorizations expire in 15 minutes. The server still deletes its ephemeral
private key. Do not interpret a prerequisite refusal as successful key cleanup.

## Modal worker SSH authentication through a private /run (#914)

OpenSSH reads `AuthorizedKeysFile` as the target login user, not as its root
listener. A root-owned authorization file beneath `/run` can therefore work for
golden builders (`root`) and refuse worker logins (`user`) if `/run` is private
(mode `0700`). The prior OS test used a traversable Docker `/run` and missed this
boundary. The new provider-owned OS regression runs both parent modes, both
trusted roles, fresh keys against the running daemon and a refused wrong-role
login. The old implementation fails the private-parent worker case with
`skillpack_ssh_authentication_failed` while the normal-parent/root controls work.

Modal SSH preparation now retains its root-managed expiring authorization store
and adds a fixed `AuthorizedKeysCommand /bin/cat /run/armada-ssh/authorized_keys`
with `AuthorizedKeysCommandUser root` as the standard OpenSSH fallback. This
executes only a fixed read-only program with a fixed path; no user/key/request
argument or shell interpolation is used. It does **not** make the worker's SSH
session root, change `AllowUsers`, permit passwords/forwarding, disable pinning,
make `/run` traversable or give the worker write access to authorization. The
same store remains covered by existing pre-snapshot SSH scrubbing and 15-minute
key expiry. A second authorization is read by the existing daemon at each auth
attempt, rather than depending on daemon startup having seen that key.

No golden rebuild or migration is required: the server generates this config for
new worker SSH daemons. Recreate the failed private parent after the server
upgrade; its failed allocation was already disposed. The staging-specific field
requested to confirm this exact cause is only
`stat -c '%n %a %U %G' /run /etc/ssh` on a disposable worker fork. The local
reproducer establishes this failure mode, not the still-unreported staging mode.
A successful live private Skillpack receipt still requires the coordinator's
post-deployment rerun and an appropriate `skills:read`-only key.
