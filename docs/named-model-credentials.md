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

Deploy migration `20261110120200_named_model_credentials.sql` before the server.
Native login/quota collection and dashboard account controls are separate work.

Until the dependent dashboard UI switches to the account control routes, direct
user-JWT model-account DELETE is deliberately fenced (the row is retained).
Use CLI/control removal. Provider singleton deletion remains available.

The replacement CAS above is for explicit user replacement/reconnect, not routine
OAuth refresh. Native auth may maintain separate encrypted state keyed by the
pinned account ID/version and rotate that state with its own auth revision;
routine refresh must not advance the account binding version.

Modal bootstrap precedes the public sandbox INSERT. Core launch therefore passes
safe account ID/version labels; the private `modal_server_harnesses` policy pins
them for every physical generation. Restore validates that same account/revision,
not a current default. Legacy Modal machines without a known binding require explicit owner recovery
rather than selecting a different billing account on restore.

## Recover a legacy unbound Modal workspace

`POST /api/v1/sandbox/bind-credential` takes `{id, credentialId, org?}`.
The API-only CLI equivalent is `armada bind-credential <sandbox-id>
--credential-id <account-uuid> [--org UUID] [--json]`.
Only the original sandbox owner, with live organization membership, can bind it;
an organization admin cannot adopt another person's workspace. The chosen UUID
must be an authorized, active, compatible account. No default is adopted.

Stop safely first. Recovery requires confirmed stopped public/private state, a
retained recovery image and no lifecycle/activity/reconciliation lease. Active,
uncertain and leased states return HTTP 409 `credential_binding_unsafe` with stop
and reconciliation guidance. An unbound send/restore returns
`credential_binding_required` (409 at the control API) with chooser/CLI guidance.
Already-bound or partially inconsistent records return `conflict`; recovery
cannot replace a bound account.

Recovery atomically CAS-pins the same ID/version on the public sandbox, private
Modal harness policy and safe machine labels. It preserves conversation IDs,
physical identity, generation, recovery image and workspace; it performs no
provider request, restart, resume or allocation. A later normal send resumes the
same retained workspace using the explicitly selected account. Success is the
safe DTO `{id, credentialId, credentialVersion, harness, status:"bound"}`.
