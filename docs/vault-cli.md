# Vault CLI

`armada vars` manages readable application configuration; `armada secrets`
manages write-only application secrets. These are separate from model credentials
(`armada creds`). Values must be piped on stdin or loaded with `--file`, never
passed as command arguments. The CLI does not cache values.

For coordinator staging acceptance, use the disposable staging checks in
[deployed checks](post-deploy-smoke.md#targeted-staging-checks), through the CLI as well as the API. Never
use production or real application secrets. Verify personal and organization
permissions, stale-version conflicts, reserved names, oversize input, revoked
names, and absence of secret values in output. Vault management itself does not deliver values to sandboxes; template references
use their separately documented raw-delivery path.

When setting an entry with `--org`, explicitly choose `--scope personal` or
`--scope org`; choosing organization context alone never opts into sharing.
Without `--org`, set defaults to personal scope in the selected organization.
Both `armada vars --help` and `armada vars set --help` show usage (likewise secrets).

Explicit `armada vars read <id> --json` returns `{ item, value }`, including empty
values. Variable lists/writes and every secret response remain metadata-only.

## Control API and limits

Authenticated no-store POSTs under `/api/v1/variables/` and `/api/v1/secrets/`
reject query parameters at direct control (the dashboard proxy strips them).
Use secure HTTP bodies/private files outside the checkout, never query values,
MCP raw-value arguments or shell interpolation. `ARMADA_ENCRYPTION_KEY` is the
existing encryption key; no extra key/provider authority is needed.

- `variables/set`: `{org,scope:"personal"|"org",name,value}`; list `{org}`
  returns metadata, read `{org,id}` explicitly returns value (including empty).
- `secrets/set`: `{org,scope,name,value,expiresAt?}`; list `{org}` returns
  metadata only. No reveal/export/read operation: direct control rejects read
  as unsupported, public proxy does not allow it.
- `secrets/rotate`: `{org,id,expectedVersion,value,expiresAt?}` advances version
  and epoch. Omitted expiry preserves it, explicit null clears it. Stale version
  is 409. `revoke`/`delete` take `{org,id,expectedVersion}` and clear ciphertext.
  Revoked names are terminal: delete before reuse; rotation cannot revive them.
- `secrets/upload`: set/rotate fields plus `operation`, returning only an opaque
  upload reference with 300-second lifetime. MCP `secret_commit` accepts
  `{org,uploadReference}`, never a raw value. Wrong actor/org, expiry or replay
  refuses without creating an active secret. Upload rotation preserves expiry
  by the same omitted/null rules.

Only owners manage personal entries; peers and org admins cannot read personal
metadata/variables. Org members read shared variables/secret metadata; only admins
mutate org entries. Removed membership fails immediately. Direct PostgREST must
not expose ciphertext or bypass these writes. Audit stores IDs, operation,
version/outcome/time, not value/length/prefix/suffix/hash. Deletion retains a
value-free tombstone. Expired uploads and audit rows older than 90 days are purged
by maintenance; backups require independent retention/restore controls.

Unknown fields, reserved names, malformed UTF-8/NUL, empty secrets and >8 KiB
values refuse without echoing input. No bearer is 401; backend failures return
safe generic diagnostics. Vault management has no sandbox/provider traffic and
does not claim raw-secret runtime filtering, safe archives or backup erasure.
Secret expiry is metadata at management time; template delivery separately
checks expiry before allowing new delivery. A compromised control service/key
holder or a copy outside the active vault is outside encryption's protection.
