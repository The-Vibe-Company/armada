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
origin. Missing key, refused key, unavailable/inaccessible skill, and general
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
The golden must already include the trusted native CLI and Node. Private secret
projection is denied by the required read-only capability set: skills requiring
secret projection fail at the API authorization boundary, before projection.

Defaults, version resolution, custom origins and secret-bearing skill packages
are outside this first credential/install slice. No live credential or production
install is used in verification; fake SSH/CLI tests execute the actual guest
script and check receipt validation, error sanitization and command-local auth.
