# Modal provider (#513)

## Provider composition

`createRuntimeModalProvider(options)` returns `{provider, captureRuntimeWork, readResourceReceipts, close}`.
The connection takes server SQL, a pinned App binding, the public Armada HTTPS URL
and the golden image lock. The provider creates compute and submits the Armada
runtime bootstrap through SDK exec. Model commands travel over the enrolled
runtime transport.

**Source access, target access and management provenance are distinct:**

- `scope` is target machine access: orgId, authenticated caller userId,
  target visibility, immutable Modal binding.
- `sourceScope` (defaults to scope) is the authorized golden snapshot scope:
  same orgId/caller/binding, golden visibility. ORG -> PRIVATE is supported.
  PRIVATE -> ORG and cross-actor/org/binding sources are refused.
- `managementAuthority?: {credentialScope:'org'|'user',credentialOwnerId:string}`
  is trusted immutable source-connection provenance, **not access visibility**.
  An ORG source must use org scope owned by source orgId. A PRIVATE source keeps
  private-owner image access but may use either its owner's user key or the source
  org fallback. Omission preserves the existing default (org for an org source,
  own user for a private source); #514 must explicitly supply the chosen org
  fallback from trusted server resolution, never change sourceScope to satisfy a
  key check. Do not derive provenance from request JSON or a profile label.
- `resolveManagementCredentials(authority)` receives `{orgId,
  sourceGoldenVisibility,credentialScope,credentialOwnerId,binding}` and returns
  `{tokenId,tokenSecret,credentialScope,credentialOwnerId}`. Returned provenance
  must match the chosen managementAuthority exactly; private->org fallback is
  selected explicitly **before** this check, not silently accepted as a mismatch.
  For fresh private goldens the server retains user-first/org-fallback selection;
  for existing resources it must resolve the previously persisted authority, not
  rerun user-first precedence after a new personal credential appears.
- Alternatively inject a **server-owned public `client: ModalClient`**. This is a
  production operator/profile path, not a test-only seam. `new ModalClient()` may
  load the operator's configured profile through the public SDK, without a manual
  credential-file read/dump. No token pair or resolver is required when client is
  explicitly provided. Optional explicit tokenId/tokenSecret must be a complete
  pair; without an injected client a complete pair (direct or resolver-returned)
  is mandatory. SDK fallback is never triggered by omitted credentials accidentally.
  The injected connection must be selected for the immutable source authority,
  never for the private target. Explicit managementAuthority also applies to this
  operator mode; profile labels never supply or override provenance. SDK clients
  injected by the caller remain
  caller-owned; close() only closes clients constructed by this factory.
- Direct explicit token pairs are also accepted for a trusted server/operator
  connection. They must already have been selected for source authority by the
  server; do not accept connection options or scopes from request JSON.

Both composition and operations use public `apps.fromName(appName,
{environment,createIfMissing:false})` and require the exact pinned AppID. A local
profile/workspace label is not authentication; actual AppID is authoritative.
There is no redirect/new-App fallback. The public SDK does not expose a separate
verified authenticated-workspace accessor.

Source snapshots use a separate SQL store. Fork reservations and
machine inspection uses target scope. No source-store fallback can
expose an org-scoped machine when a private target was requested. A fork persists
source Image lineage; subsequent machine operations refuse a provider connection
with the wrong source authority, even when both connections reach the same App.
New Machine and SavedImage records retain the nonsensitive managementAuthority
(scope/owner only). Snapshot lookup/fork, physical lifecycle and GC compare it to
the selected connection; wrong-authority adapters cannot mutate resources or
collect that authority's tombstones even when both keys reach the same App. GC
still counts all authorized cross-target references conservatively. #514 persists
the same context with its source record and supplies it on restore. Legacy rows
without this metadata rely on that trusted persisted server context and AppID;
no credential owner is inferred from profile labels or resource visibility.

Split adapters can read source snapshot metadata and fork, but cannot create or
mutate golden snapshots through the target private scope. Route those golden
operations through the source adapter. Keep sourceScope when resolving existing
private forks, including after the named source snapshot has been deleted.

The low-level `createModalProvider` exposes the same split as
`source:{scope,store}` plus target `scope`/`store` and the same optional
managementAuthority provenance. It also accepts explicit
public client injection. `ModalStore.imageReferenced` is a server-only boolean
reference check: it counts private target references across visibility scopes
without returning private resource IDs, owners, events or rows to a source caller.
Snapshot retirement and fork reservation serialize on the saved-image row.
Store entry points recheck live organization membership, including for private owners. Lifecycle phase
commits renew the 15-minute lease, and expired holders cannot commit late results.
Image collection claims expire after five minutes. Tombstone deletion matches the
name, source and image ID so a late collector cannot purge a replacement artifact.

## SSH and durable lifecycle

`sshKey({sandboxId,key})` returns `{sshEndpoint,hostKey,username}` matching main's secure
SSH executor. It validates an Ed25519 public key and provisions actual OpenSSH on
port2222 through Modal's raw TCP tunnel; SSH itself encrypts/authenticates traffic.
It generates a per-generation Ed25519 host key and returns its real public key for
strict pinning. Client authorizations expire after15 minutes. Password/agent/TCP/X11 paths are disabled; root key-only login is golden-only. Private host keys never leave the machine.
SSH provisioning requires active admission and the current generation under the
lifecycle lease, so it cannot recreate authorization or host keys after checkpoint/scrub.

Retained stop uses the exact enrolled physical generation and durable runtime
checkpoint. The provider quiesces writers, records the recovery image, and then
terminates compute. Resume uses that checkpoint and the same logical ID with a
new physical generation. Snapshot uncertainty preserves the source. Golden
builders use credential-free SDK exec and their own filesystem checkpoint.

Goldens are immutable/provider-bound, use ttlMs:null and contain no managed model
credentials/sessions/bootstrap/host keys. Named snapshot deletion refuses while a
non-deleted fork references the exact saved image, including across private and
organization scopes. Fork admission pins the image in a short reservation transaction.
Retirement records a durable tombstone before physical collection. Collection
preserves referenced artifacts, including historical tombstones and images shared
by multiple handles. `collectRetiredSnapshot(name)` retries collection for a
specific retired snapshot.
Control tables are server-only/RLS-enabled. Secure golden org-admin authorization
remains upstream, in addition to live membership/owner/binding checks here.

### Authorized golden master restore / NULL canonical master (#546)

`restoreGoldenMaster({snapshotId,sandboxId?}): Promise<SandboxInfo>` is a public
server-side extension. snapshotId is the owned provider snapshot reference used by
getSnapshot/fork, **not** an arbitrary Modal Image ID. When canonical master is NULL,
omit sandboxId: the adapter derives SavedImage.sourceId from the authorized source
store. An optional supplied ID must match exactly. The source row must be golden,
the snapshot ready, and source access/management authority/App binding must match.
Call through a source-scoped provider, after core owner/admin authorization. No
ordinary model-credentialed worker fork is used as a builder.

The source lease records a restore intent, terminates a known sealed predecessor,
and creates a credential-free physical builder under the SAME logical master ID
with a new generation. Same reference/generation retries reconcile deterministic
names and healthy boot before starting anything again. An already-open matching
master is returned without discarding edits. A different active restore context or
an uncertain checkpoint is refused. Safe stopped golden recovery uses its retained
working checkpoint for the matching latest named base, preserving unsaved repo edits.
Core514 still owns canonical adoption/CAS, including expected NULL pointers.

Owned distribution sanitizes inherited managed state before first bootstrap of a
new physical golden master or a new logical fork, including legacy owned Images.
A durable freshStatePreparedGeneration marker is saved BEFORE boot: a same-ID/gen
retry never purges its journal/fence again. Working recovery generations skip this
fresh purge. A legacy snapshot can be restored only with
a distribution supplying this fresh sanitization port; new golden snapshots retain
an explicit clean-history marker. Golden restore explicitly opens a new generation.

### Failure/resource provenance receipts

Launch/snapshot/stop failures after an authorized reservation throw ModalOperationError
with `receipt` and `details.resourceReceipt`; `modalFailureReceipt(error)` returns it.
The whitelist contains logical/physical IDs, deterministic name, durable/observed phase,
registryConfirmed, generation, Image/source/recovery references, binding and nonsensitive
management provenance. No request/env/MCP config, auth, labels, prompt text or raw SDK
cause is included. SDK error classification uses recognized error names and
validated numeric gRPC statuses from SDK ClientError instances. Public builder
image failures keep only recognized build diagnostics, and lifecycle failure logs
use allowlisted labels. Check the durable lifecycle phase before retrying any
mutation, including when a transport error is marked retryable. Known SDK Image
IDs survive in a failure receipt even when their SQL commit failed. New named
snapshot IDs are also retained in Machine.snapshotImages.
The SDK response-loss case where no Image ID was ever received remains unrecoverable.

The scoped Modal connection’s `readResourceReceipts()` inventories authorized target/context records (including
deleted history) without requiring a healthy Modal service. Call it **before** closing
a disposable fixture DB. `mergeModalResourceReceipts` preserves all observed Image IDs
when later durable reads lack an interrupted commit's metadata. Do not blindly delete
source/shared Images: retain their provenance and use normal reference-aware cleanup.
Production operation failures never auto-delete uncertain user data.

### Delete after an unknown create outcome

Creation commits `creating` before its SDK request and sets exact logical/scope/
generation ownership tags in that request. If delete finds no persisted physical
ID, it reconciles the exact deterministic name under the pinned App/environment,
including terminated machines, and verifies those public SDK tags **before any
phase flip or termination**. A mismatching resource is never modified. Reconciled
owned IDs are durably saved before deletion proceeds. A reserved pre-create phase
is provably absent; a creating name lookup returning NotFound is **not** proof of
absence, since a delayed create can still land. Such outcomes, unavailable lookup
or unavailable ownership verification preserve the creating reservation with an
actionable retry error. No blind create/replacement and no deleted success occurs.

### Unavoidable public snapshot response-loss limit

Public Modal0.11.1 `snapshotFilesystem({timeoutMs,ttlMs})` returns an Image only on
completion, with no caller name/tag/job/idempotency handle.
[Image.publish](https://modal.com/docs/sdk/js/latest/Image) requires that returned
Image first; fromName can only resolve already published Images. The
[Sandbox API](https://modal.com/docs/sdk/js/latest/Sandbox) exposes no snapshot-job
lookup/list-by-source operation. Thus publishing afterward cannot recover an ID
lost in the initial response. Phase snapshot fails closed and preserves source /
checkpoint; an orphan Image with an unknown ID remains an unavoidable cleanup gap
with this supported API. No private RPC or invented job handle is used.

## Validation

Run `bun test packages/provider-modal/test` for the provider unit tests.
The optional OS conformance probes cover the pinned image, SSH roles and
golden filesystem preparation. See the [validation contracts](../../docs/validation-contracts.md)
for release checks and the [golden OS fixture](../../scripts/fixtures/golden-os/README.md)
for the local image recipe.
