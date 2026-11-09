# Sandbox access v1 (#680)

Source contract: `packages/core/src/sandbox-access.ts`, exported from `@armada/core`.
`SandboxListMetadata` is the exact allowlist for MCP/API/CLI and dashboard lists.
All current organization members may list it, including existing private/org rows,
private or removed source goldens, and rows whose legacy access owner differs.
Protected orchestrator parents are excluded. There is no global/public list.

Fields: id, orgId, ownerId, provider, harness, model, reasoningEffort, status,
createdAt, stoppedAt, expiresAt, effectiveTtlSeconds, machineSize (effective size
only, no repository evidence), displayLabel (`Sandbox ` plus logical UUID),
canOpen, canManage. Dates are ISO strings; nullable fields are explicit nulls.
No golden name/id/config, physical provider id/binding, conversation, repository,
prompt, history, raw failure reason, credentials or grants belong in this DTO.

Interior and protected operations require current organization membership and
owner_id = caller OR current admin. Legacy visibility and access_owner_id do not
participate. `canAccessSandboxInterior` is a browser-safe pure helper for callers
that already obtained a CURRENT membership role; token roles are not sufficient.
Server SQL predicates and database RLS enforce this independently. These booleans
are UI hints, not capabilities. A subsequent operation must reauthorize.

Dashboard read port: `public.sandbox_list_metadata()` (authenticated, no arguments),
returns the exact camelCase DTO rows in the caller's current organizations; raw
sandbox SELECT remains interior-only. Consumers may filter/paginate these safe
rows. MCP/API list count and pagination use identical current-org predicates.
Backend owns this RPC/type/server boundary; UI consumer owns dashboard adapters,
rendered pages and chooser removal. Sibling owns connections.ts and migration212.

## Compatibility and independent authority

Legacy launch `visibility=private|org` remains accepted but deprecated; it cannot
change access. Source golden visibility still determines provider/payment lookup
and golden access. No source/billing ownership or personal credential/grant
ownership is rewritten. Admin interior access does not authorize reading,
decrypting, refreshing or reissuing another user's personal OAuth/grants.

## Capability boundary

Owner/admin interior includes arbitrary guest exec and files. Such access can
read guest files and any capabilities already delivered to that guest; it cannot
mathematically conceal guest-resident secrets from an administrator with exec.
The control-plane vault and personal grant ownership remain separate. Guest MCP
leases must retain their own current actor/grant checks; sandbox admin permission
alone is not authority to issue a personal lease. Never weaken grant authority to
make admin exec work. Existing guest capabilities may need revocation before an
admin enters; deployment must account for the sibling lease policy.

## Deployment (no rolling old readers)

Drain old API/MCP servers, dashboard deployments, in-flight protected requests and
workers before activating this migration and new readers/writers together. Keep
traffic disabled until the matching dashboard RPC consumer and sibling lease
policy are deployed and verified. Old list readers would emit raw interior
fields; old writers may apply legacy visibility checks. Do not broaden raw table
SELECT or roll back to old readers while leaving org metadata exposure active.
Rollback requires draining again and restoring a compatible full application /
schema combination. This change does not rewrite persisted source authority,
CAS generations, unknown-operation fences, jobs, namespaces or tombstones.
