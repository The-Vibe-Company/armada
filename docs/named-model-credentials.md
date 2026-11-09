# Named model accounts

Boat and Modal remain canonical singleton provider credentials. Model accounts use
`credentials.id` (UUID), canonical encrypted `value_enc`, and safe metadata:
`id`, `kind`, `name`, `isDefault`, `status`, `expiresAt`, `updatedAt`, `version`
(and the legacy `createdAt`). No account DTO contains ciphertext or plaintext.

All control routes are authenticated POSTs under `/api/v1/`:

- `creds/list`: optional `org`; returns `{user, orgs}` with safe metadata.
- `creds/accounts/set`: `scope`, optional `org`, `kind`, `value`, optional `id`, `name`, `expiresAt`. Existing-ID writes require `expectedVersion`; stale revisions return conflict before publication.
  Without ID creates an account; with ID rotates that account's secret. Kind is immutable.
- `creds/accounts/rename`: `scope`, optional `org`, `id`, `name`.
- `creds/accounts/default`: `scope`, optional `org`, `id`.
- `creds/accounts/remove`: `scope`, optional `org`, `id`; retains a deleted tombstone.

Mutations return `{account}`. Org writes require a fresh admin check inside the
mutation transaction. Personal writes address only the caller's rows.

CLI equivalents: `armada creds set openai --name Work` (stdin or `--file`),
`creds set openai --id <uuid> --expected-version <revision>`, `creds rename <uuid> <name>`,
`creds default <uuid>`, `creds remove <uuid>`, and `creds list --json`.
Each supports `--org <org>` where applicable. `launch --credential-id <uuid>`
selects an explicit account (`credentialId` in the control API and MCP launch).

Legacy `creds set/rm <kind>` updates/removes the sole nondeleted row of that kind;
multiple rows produce a conflict requiring an ID. Legacy set also rejects duplicate
accounts of another compatible kind in that harness, before writing anything. Legacy kind writes preserve
historical harness-kind preference through defaults when only legacy-named rows
exist. Migration sets explicit defaults using Claude OAuth before Anthropic and
OpenAI before Codex auth.json. Provider singleton storage is unchanged.

Resolution selects an authorized explicit compatible account, otherwise personal
harness default, sole compatible personal row, org default, sole compatible org
row. Ambiguity, expired/revoked/deleted selections and incompatible explicit IDs
fail, never silently change billing. Removed defaults remain blocking tombstones
until another default is chosen. Model credentials are injected only at launch,
never into goldens.

Launch persists `sandboxes.credential_id` and `credential_version` (TypeScript
`credentialId` and `credentialVersion`). `HarnessCredentials.binding` carries the
selection from the resolver to persistence. Send validates this original binding,
not current defaults. Secret updates increment version; rename/default edits do
not. Deleted rows remain for historical identity and cause pinned sends to fail
explicitly. Native authentication/usage consumers should use this binding and
must not resolve a current default. Legacy unbound sandboxes remain unbound.

Follow [the202 maintenance cutover](named-model-credentials-cutover.md): remove
old production writers before202, deploy the new backend before #618, and reopen
named writes only after backend and frontend are both ready.
Native login/quota collection and dashboard account controls are separate work.

Direct user-JWT model-account INSERT, UPDATE and DELETE are deliberately fenced;
canonical model writes use the authorized service-role account API. Safe metadata
reads remain available. Provider Boat/Modal writes keep their existing owner/admin
rules and canonical singleton storage.

The replacement CAS above is for explicit user replacement/reconnect, not routine
OAuth refresh. Native auth may maintain separate encrypted state keyed by the
pinned account ID/version and rotate that state with its own auth revision;
routine refresh must not advance the account binding version.

Modal bootstrap precedes the public sandbox INSERT. Core launch therefore passes
safe account ID/version labels; the private `modal_server_harnesses` policy pins
them for every physical generation. Restore validates that same account/revision,
not a current default. Legacy Modal machines without a known binding require explicit owner recovery
rather than selecting a different billing account on restore.
