# Vault CLI

`armada vars` manages readable application configuration; `armada secrets`
manages write-only application secrets. These are separate from model credentials
(`armada creds`). Values must be piped on stdin or loaded with `--file`, never
passed as command arguments. The CLI does not cache values.

For coordinator staging acceptance, use the disposable staging checks in
[vault-staging.md](vault-staging.md), through the CLI as well as the API. Never
use production or real application secrets. Verify personal and organization
permissions, stale-version conflicts, reserved names, oversize input, revoked
names, and absence of secret values in output. This CLI change adds no migration
and does not deliver values to sandboxes.

When setting an entry with `--org`, explicitly choose `--scope personal` or
`--scope org`; choosing organization context alone never opts into sharing.
Without `--org`, set defaults to personal scope in the selected organization.
Both `armada vars --help` and `armada vars set --help` show usage (likewise secrets).

Explicit `armada vars read <id> --json` returns `{ item, value }`, including empty
values. Variable lists/writes and every secret response remain metadata-only.
