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

Armada accepts any valid Skillpack key with the read permission needed for the
install, including broader keys. We recommend a read-only (`skills:read`) key,
but do not require it. Invalid, expired or revoked keys still fail authentication;
a key without access to the requested skill fails the install.

A compromised or prompt-injected sandbox that reads the key during the install
window can do whatever that key allows on Skillpack, not only read skills.
Native CLI presently does not enforce its `--confirm-secrets` flag; a broader
key can also authorize secret projection. Use only trusted skills and sandboxes.

Use `armada creds set skillpack --file <private-file>` or pipe the value on
stdin. Add `--org <organization>` for an org default (admin only). Your own
credential wins over the org's, and a refused personal key never silently falls
back to wider org authority. Storage uses the existing AES-GCM encrypted vault;
a user JWT cannot read `value_enc`. The value is never an argument.

Ordinary sandbox launch accepts `armada new SNAPSHOT --provider boat --agent codex --skill notes@1.0.0`
(and repeated `--skill` flags). The API `skills` array accepts both private
`slug@exact-version` and public `org/slug@exact-version` pins, as do template and
delegated child launches. Distinct pins must have distinct installed slugs.
A key is resolved
lazily only for private pins, after normal owner/org authorization, with user over
org priority and no fallback after a refused personal key. Installation and receipt
persistence precede the first turn; the key never enters the harness environment. Qualified references
remain anonymous; the private key is not resolved or sent for those installs.
The receipt records the exact reference, version, skill UUID, checksum and fixed
origin plus the authenticated `workspaceId` (public receipts omit this field).
Missing key, refused key, unavailable/inaccessible skill, and general
installation failure have separate closed diagnostic reasons. Provider/tool
output is never forwarded.

Launch failures expose a closed `reason` and `stage` through the API, and the
CLI reports the same classification. The snapshot scan includes Skillpack
tokens.

Enrolled runtimes install skills through an epoch-fenced runtime command.
The native provider path uses pinned-host SSH and passes the key to the
installer through its child-process environment. Both paths discard the key
after installation and keep it out of the harness environment. Snapshot builds
provision the Skillpack CLI. Before launch, check the snapshot build result
for provisioning warnings.

See [default pins](skill-defaults.md) for how Armada resolves skills at launch.

## Ordinary launch parity (#983)

On Modal staging, the coordinator can use a private pin and a configured
Skillpack credential with:

```sh
armada new SNAPSHOT --provider modal --agent codex --skill notes@1.0.0 --json
```

Boat checks are coordinator-only and on demand. Check `sandbox.skills[]` for
the exact reference, version, checksum, fixed origin and expected `workspaceId`; ask the first turn to
read a known installed marker. Confirm missing/revoked private credentials fail
with a closed reason before any prompt, and a public-only launch never requires
a Skillpack credential.
