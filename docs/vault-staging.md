# Vault slice 1 staging acceptance

Run only against a disposable staging database after its operator applies the new
migration. Never use production credentials or real application secrets. Use a
random disposable canary and authenticated JSON request bodies; do not put values
in URLs, shell arguments, MCP arguments, or command logs.

## Required checks

- As a personal owner, create a readable variable (including an empty value), list
  its metadata, and explicitly read its value. Another user and an organization
  admin must not see it.
- Write a personal application secret through the authenticated control API.
  Creation, list, replacement, revocation and deletion responses must contain
  metadata only. No reveal/export operation exists.
- With two organization members, one admin and an outsider, verify current members
  can read organization variables and secret metadata; only the admin can mutate.
  Remove a member and verify their next request is denied.
- Attempt stale-version rotations and concurrent revoke/rotation. At most one
  mutation succeeds; versions and revocation epochs advance atomically.
- Test duplicate names, unknown fields, reserved names, invalid encoding, NUL,
  empty secrets and values over 8 KiB. Errors must not echo the canary.
- Probe direct PostgREST as anonymous, owner, member and admin: ciphertext is not
  selectable, direct writes cannot bypass the API, personal rows remain private.
- Inspect audit rows: actor/resource IDs, operation, version, outcome and time
  only; no value, length, prefix, suffix or value hash. Deletion removes active
  ciphertext and preserves a value-free tombstone.
- Verify MCP has no raw secret-value argument. If secure upload references are
  offered, test caller binding, expiry and single-use replay rejection.
- Observe provider requests: these operations must cause no sandbox/provider traffic.

## Explicit limits

This slice does not deliver variables or application secrets to sandboxes.
It does not add templates, routines, CLI, dashboard or iOS management.
It does not protect existing model credentials, arbitrary prompts, logs, provider
transcripts, work-preservation archives or agent/network output with application
secret filtering. Encryption does not protect against a compromised control
service or encryption-key holder. Deletion does not erase backups or copies made
outside the active vault; restore must preserve tombstones and expiry.
No raw-secret launch security guarantee is enabled by this change.
