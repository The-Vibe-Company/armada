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
| `skillpack_cli_unavailable` | Rebuild the golden with the trusted native CLI executable on PATH; check its permissions/version. |
| `skillpack_auth_unavailable` | Check registry connectivity and CLI/API compatibility during auth status. |
| `skillpack_protocol_invalid` | Update the trusted native CLI/API; auth status did not return the supported workspace contract. |
| `skillpack_skill_unavailable` | Check the bare slug, exact version and key's workspace access; secret-projecting skills are not supported. |
| `skillpack_install_conflict` | Inspect project lock/install state in a disposable sandbox; rebuild a clean golden. |
| `skillpack_request_rejected` | Check the requested version/tool and update CLI/API compatibility. |
| `skillpack_registry_unavailable` | Check registry/network availability, then create with a new idempotency key. |
| `skillpack_timeout` | Check guest resources and registry connectivity; inspect before retrying. |
| `skillpack_receipt_invalid` | Rebuild with a compatible native CLI; inspect project permissions and lockfile without exposing package contents. |
| `skillpack_transport_failed` | Check SSH connectivity, Node, Bash, `flock`, home permissions and pinned-host access. |
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

Golden create **and update** install Skillpack **0.3.5** before user init and the
secret scan. Armada downloads the versioned official installer over HTTPS,
checks its repository-pinned SHA-256
`8910925ff024eaac513d1419bcea6be7a1080f787fad368b3848c7ac94c9c02e`, and
only then executes it. That installer embeds the platform archive checksums,
verifies them before extraction, and self-tests both native binaries. Linux
x64 and arm64 are supported. A checksum mismatch in the downloaded bootstrap aborts the build before
execution (`skillpack` phase), retaining the previous golden. Every build
attempts HTTPS egress to github.com and its release-asset hosts for provisioning.
If those hosts are unavailable, the build continues without adding Skillpack,
logging the closed warning `golden_skillpack_warning/download_unavailable`;
if the pinned installer cannot complete, it logs `install_unavailable`. Other
launcher functions remain usable. Before using skills, allow that egress and
rebuild; a missing executable is still refused as `skillpack_cli_unavailable`. No login or Skillpack key is
used during building. The managed executable is made available through
`/usr/local/bin/skillpack` when writable (directly for root) or passwordless
sudo is available. Otherwise the build keeps the user-local executable and logs
`user_local_only`; orchestrator skill installation includes `/home/user/.local/bin`
on its command-local PATH, so passwordless sudo is not required for Skillpack.
Ownership normalization covers the home-directory installation. This belongs in golden baseline provisioning rather than every
skill install: it keeps runtime installation offline except for the registry,
avoids repeating executable downloads with a live credential present, and
requires no new API or migration.

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
`skillpack_scope_refused`. Confirm a non-null skill receipt and a ready parent.
Send only closed stage/reason if it fails, not raw auth status or a key value.

The public sandbox-launch path now reports the same closed missing-CLI reason
and `golden update` action, with distinct request/package/registry/receipt/transport
classifications. It discovers the user-local executable too. Native install-stage
usage exit (2) is `skillpack_request_rejected`, not a missing CLI; auth-status
usage exit (2) signals an incompatible CLI.
