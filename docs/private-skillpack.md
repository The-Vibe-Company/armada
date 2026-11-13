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

Ordinary sandbox launch accepts `armada launch <golden> --agent codex --skill notes@1.0.0`
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

The server-only `installPrivateSkill` function owns the shared installation boundary. Ordinary
launch failures expose the closed `reason` and `stage` through the API; the CLI
reports the same closed classification in its error message, without forwarding
installer or provider output. Receipts are
returned in the existing sandbox `skills` field, including private `workspaceId`.
Golden skill configuration is unchanged; future golden callers must install
before the existing snapshot scan, whose PAT pattern includes Skillpack tokens.

Transport uses pinned-host SSH stdin. The key is passed only in child process
environment to `skillpack auth status` and `skillpack install`, then discarded;
no `auth login`, profile write, argv secret or provider command journal is used.
The freshly authorized SSH key is removed under the shared `authorized_keys`
lock **before** the installer runs, including on refused/missing-skill paths;
unrelated keys and file metadata are preserved. Golden create/update installs the trusted native CLI automatically; the base
image must supply Node, Bash and `flock`. A read-only key limits authority during the install window; broader keys do not
provide that capability fence.

Defaults, version resolution, custom origins and secret-bearing skill packages
are outside this first credential/install slice. No live credential or production
install is used in verification; fake SSH/CLI tests execute the actual guest
script and check receipt validation, error sanitization and command-local auth.

## Ordinary launch staging parity (#983)

After approved staging deployment, run the ordinary `armada launch` command above
for Boat Codex and Modal Codex with a staging private pin and a configured
Skillpack credential. Check `--json` output `skills[]` for the exact reference,
version, checksum, fixed origin and expected workspaceId; ask the first turn to
read a known installed marker. Confirm missing/revoked private credentials fail
with a closed reason before any prompt, and a public-only launch never requires
a Skillpack credential. This PR performs no deployment or live-provider install.
