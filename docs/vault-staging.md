# Vault slice 1 staging acceptance

Run only against a disposable staging database after its operator applies the new
`20261110221000_application_vault.sql` migration. Never use production credentials
or real application secrets. Use a random disposable canary and authenticated JSON request bodies; do not put values
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

## API calls and expected results

All routes below are authenticated POSTs under `/api/v1/`, return no-store
JSON, and reject query parameters. Use a request-body file outside the checkout,
or a test HTTP client; never interpolate a canary into shell arguments.

1. `variables/set` with `{org,scope:"personal",name:"APP_REGION",value:""}`
   returns `item` metadata (version/epoch 1), without a value.
   `variables/list` with `{org}` returns metadata only.
   `variables/read` with `{org,id}` returns the explicit readable value.
2. `secrets/set` with `{org,scope:"personal",name:"APP_TOKEN",value}`
   returns `item` metadata only. `secrets/list` with `{org}` never includes
   ciphertext or value-derived fields. `secrets/read` must fail (400).
3. `secrets/rotate` with `{org,id,expectedVersion:1,value}` returns version
   and epoch 2. Repeat with version 1: 409. `secrets/revoke` and
   `secrets/delete` use `{org,id,expectedVersion}`, advancing version/epoch
   and clearing active ciphertext. Revoked entries cannot rotate.
4. For MCP ingress, `secrets/upload` with
   `{org,operation:"set",scope:"personal",name:"APP_TOKEN",value}` returns
   only a random reference and a 300-second lifetime. Call MCP `secret_commit`
   with `{org,uploadReference}`: metadata only. Replay, wrong caller/org or
   expired reference fails; no active secret is created. To rotate, upload with
   `operation:"rotate",id,expectedVersion,value`, then commit the reference.
5. Switch scope to `"org"`: a member's write must fail (403), admin write
   succeeds, members can list metadata and explicitly read variables, outsiders
   fail. Personal IDs return 404 to other members, including admins.
6. Missing bearer: 401. Query parameters, unknown fields, malformed UTF-8,
   reserved keys and oversize values: 400, without submitted content.
   A database/backend failure: generic unavailable error, no raw database text.

The operator must configure the existing `ARMADA_ENCRYPTION_KEY` before writes.
No additional encryption key or provider credentials are introduced. Online upload
expiry is five minutes, with expired rows and audit rows older than 90 days purged
by the existing server maintenance worker. Backups require separate retention and
restore controls; these purges do not erase backup copies.
