# Modal provider (#513)

## Root / #523 factory contract

`await createComposedModalProvider(options)` returns `{provider, ingest, close}`.
Mount `ingest` at the exact public HTTPS `ingestUrl` under the server's `/api/v1`
routing. Provide transactional server SQL, persistent random >=32-byte signingKey,
appName, artifact and resolveHarnessEnvironment.

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
  server; do not accept connection options or scopes from request/runner JSON.

Both composition and operations use public `apps.fromName(appName,
{environment,createIfMissing:false})` and require the exact pinned AppID. A local
profile/workspace label is not authentication; actual AppID is authoritative.
There is no redirect/new-App fallback. The public SDK does not expose a separate
verified authenticated-workspace accessor.

Source snapshots use a separate SQL store and source lease. Fork reservations,
get/list/events/runner grants use only target scope. No source-store fallback can
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
GC and fork reservation serialize on the source lease.

## Runner / grants / credentials

The factory composes actual Modal0.11.1, SQL registry, HMAC sandbox/generation/expiry
application grants, protected HTTPS `createConnectToken` access and distribution.
Modal proxy token uses Authorization; the runner application token uses
`x-armada-runner-grant` because Modal strips Authorization. Tokens are never stored
in registry JSON. Ingest validates live membership, scope, generation and producer
sequence, dedupes identical replays, rejects conflicting replay and ACKs only after
contiguous durable commit. No database/user/provider token reaches the runner.

`resolveHarnessEnvironment(machine,launchEnv)` runs for each active generation,
never for golden builders. It returns allowlisted `claudeEnv`, `codexEnv`, optional
`codexAuthJson` and optional MCP `{revision,servers:{name:{type:'http',url,headers?}|
{type:'stdio',command,args?,env?}}}`. On restore launchEnv is empty: resolve current
credentials from the trusted launch identity, including persisted launchUserId;
never restore secrets from a cached SQL/bootstrap payload. Model defaults are
persisted and forwarded per logical machine (Opus5.5 medium / GPT6.1Sol medium).

Private stdin bootstrap is protocol1: root,cwd,port,grant,claudeExecutable,
codexExecutable,claudeEnv,codexEnv,ingestUrl and optional codexAuthJson/mcp.
Generation is a string. No bootstrap secrets enter argv, logs, Image ENV or files.
`env -i` prevents management environment inheritance; a generation-local flock
prevents duplicate runners on uncertain start retries. Start verifies authenticated
health/readiness before admitting user work.

## Private exec environment / final #510 contract

Applied runtime reference source/test/README from staged HEAD79609e6 without changing
its package/version metadata. Private bootstrap now always sets
`credentialFreeBuilder: machine.golden`. Builders get empty harness credentials and
no GitHub exec credentials; runtime independently refuses builder model prompts,
credential-bearing exec bootstrap and nonempty MCP config.

Ordinary first startup projects **only GH_TOKEN/GITHUB_TOKEN** from trusted launchEnv
into a separate `execEnv`; model/provider keys, arbitrary HOME/PATH and other fork
variables are never merged into exec. Provider defaults are HOME=/home/user,
PATH=/usr/local/bin:/usr/bin:/bin, GIT_CONFIG_GLOBAL=/home/user/.gitconfig and
GIT_TERMINAL_PROMPT=0. Runtime validates this narrow allowlist again, registers auth
values with its redactor and removes transient GitHub CLI caches before checkpoint ACK.

`HarnessEnvironment.execEnv?: ExecEnvironment` is the explicit server-resolved path
for restore. If present, it is authoritative (including `{}` to disable GitHub) and
may supply only the runtime's six allowlisted fields. #514 must retain the original
**launch-enabled** flag in trusted canonical context: resolve fresh GitHub access
only when that flag was enabled, on initial startup and each restore. First startup
can also use the trusted launchEnv aliases. On restore launchEnv is empty; never
reuse or persist the previous token/environment in Machine, labels, receipts, logs,
Images or server SQL. This callback is data-only and does not recurse into prepare RPCs.
All environment material travels solely through private stdin bootstrap, not argv.

The actual isolated artifact test executes core gitSetupCommand and credential-helper
lookup with synthetic exec-only GitHub credentials and temporary HOME/GIT_CONFIG_GLOBAL,
checks redacted output and absent model keys, and calls the real configureMcp handler.
No actual user/global git configuration or credential file is read or modified.

### Required model tool PATH (actual Codex npm launcher)

Both claudeEnv and codexEnv receive explicit trusted
`PATH=/usr/local/bin:/usr/bin:/bin`, without merging the parent/server environment.
The npm Codex entrypoint uses `/usr/bin/env node`; credentials-only environments
otherwise exit127 even though dist/codex native-binary smoke succeeds. Trusted
resolver PATH overrides are preserved only as canonical absolute POSIX directory
lists (no URL/auth string, relative component or control character). This is a
model environment baseline, separate from GitHub-only execEnv.

## Native harness cwd (#535/#540)

`provider.prepareNativeHarnessCwd({sandboxId,harness,cwd}): Promise<void>` records a
validated, nonsensitive absolute POSIX path in `Machine.harnessCwds[harness]` under
the target lifecycle lease. Trusted core must first validate repository selection
against the golden and finish initialization; this hook does not allocate a new logical sandbox,
validate an arbitrary repository, install root executable wrappers or rewrite prompts.
It verifies current/resumed physical and runner admission before committing the path,
refuses builders/sealed admission, and works for idle launches without starting a turn.

Every subsequent prompt (including continuation by conversationId after stop/restore)
adds the persisted path only as private protocol1 `input.cwd`. An unprepared harness
omits that field and uses the runtime default; arbitrary caller prompt cwd fields
cannot override durable preparation. Claude and Codex paths are independent. Steering
sends no cwd override, so the running conversation retains its original context.
Paths survive physical generations in server-owned JSON registry state, never in
credential/env fields. No Boat SDK fields or wrappers are introduced; Runtime510 owns
native process, Claude query and Codex thread/start/resume/turn cwd application.

## Trusted before-prompt lifecycle hook (#523 / #514)

Both ModalProviderOptions and ComposedModalOptions accept optional
`beforePrompt(provider: ModalProvider, sandboxId: string): Promise<void>`. Root514
wires actor/current-membership-aware `mcp.beforePrompt` here; this is not a runner
bootstrap resolver and never runs under the store lease. With a hook, prompt first
actually readies/restores and verifies the runner under admission, captures trusted
physical incarnation state, releases the lease and awaits the callback. The callback
can safely call get/configureMcp with their own leases. Failure refuses the turn.

Native prompt admission then reacquires the lease and rejects any changed phase,
physical ID/generation, bootstrap-grant epoch or trusted process namespace, both
BEFORE and AFTER healthyAdmission (which may complete a restore). No stale-config
turn is submitted after an intervening checkpoint/replacement. Stable parallel
conversations remain supported. Golden model prompts are rejected before the hook
or any model start. No callback is invoked from resolveHarnessEnvironment; initial
post-init connections.prepare remains core523's responsibility. No new factory
arguments other than this optional trusted callback and no request/label identity
fields are introduced.

## Post-init MCP bridge (#523)

The returned provider implements the optional structural core extension:
`configureMcp({sandboxId,configuration:{revision,servers}}): Promise<{revision}>`.
It sends protocol1 `{version:1,requestId,sandboxId,op:'configureMcp',configuration}`
through the same protected HTTPS/current-generation application grant as other RPCs.
No nested `input` wrapper is added. The only returned value is the exact acknowledged
revision; extra runner fields/config/auth are never echoed or saved in provider SQL.
HTTP success/enveloped errors must match version/requestId; existing protocol1 bare
safe errors on HTTP409 remain supported without changing the frozen wire protocol.

Register this provider through the real server provider factory before core calls
`connections.prepare`. First fork boot precedes canonical Armada sandbox/binding
insertion: core523 must call configureMcp with authoritative leases/config after
that insertion and before prompting. Do not assume bootstrap's optional config was
authoritative when the new providerSandboxId had no canonical DB row yet. On restore,
resolveHarnessEnvironment can load current config by trusted providerSandboxId and
launch owner, before fresh-generation bootstrap. Core's post-init/prepare RPC may
then set the authoritative revision again. Empty servers removes connections;
revision replay/conflict semantics and dynamic auth redaction/cleanup belong to #510.

Configure acquires the lifecycle lease, resumes if needed, verifies active physical
health, and holds the lease through its RPC/receipt validation. Prompt/steer admission
shares that lease, but releases after the receipt, not after the model turn; parallel
conversations remain possible. Contended active admission retries only a SQL lease
that ran no callback, never an uncertain remote operation. Sealed golden admission
cannot reopen; golden builders cannot receive model connection configuration. No
MCP config/auth is attached to provider registry rows, logs or Image layers. Runtime
checkpoint must scrub post-boot configured credentials before returning its ACK.

## Actual artifact / immutable deployment lock

Build unchanged `packages/agent-runtime/build.ts` on target Linux with Bun1.4.2,
Claude SDK0.3.322, native Claude2.1.322 and Codex0.167.0 installed.
`loadRunnerArtifact(dist)` validates manifest/native resource presence and hashes
actual bundled main.js. Image construction gzip-compresses those bytes, appends
base64 in <=32 KiB Dockerfile RUN chunks, then decodes, verifies the original
SHA-256 and atomically installs main.js before deleting scratch files. No RUN puts
the full bundle in a shell argv (Linux MAX_ARG_STRLEN is 128 KiB). A real Linux
shell replay of captured image RUNs tests a 1 MiB incompressible artifact, including
the old E2BIG failure and digest-failure publication safety. Native tools/vendor resources are installed in the remote
image from those same pinned official npm packages, not unpublished workspace
imports. Build removes installer-created SSH host keys and npm caches.

The coordinator-approved Linux-amd64 Node/Debian OCI digest and exact apt versions
are exported as **MODAL_IMAGE_LOCK** (`src/image-lock.ts`), resolved from the official
Node manifest and apt policy in a real disposable Modal probe (terminated). Git,
gh, sshd, Bun and both harnesses are installed with `/home/user/repos` writable by
user. No named Modal Secret/account environment is inherited. The non-secret
conformance App/name/environment binding is exported as MODAL_CONFORMANCE_APP;
workspace metadata still comes from the trusted connection record.

For the single CLI/server binary, import `loadEmbeddedRunnerArtifact` from
`@armada/provider-modal/embedded` after the runtime build. Merge returned bytes/hash
with MODAL_IMAGE_LOCK in artifact. Bun embeds main.js and its manifest as file
assets: the compiled server needs no external runtime/workspace files. Native
executables are installed only in Modal, not as host binaries. The compile smoke
imports the actual composed factory and embedded artifact on all four targets.

## Authorized VM build privilege and independent runner Bun

The exact approved OS lock includes sudo=1.9.13p3-1+deb12u4. Worker SSH/checkouts remain
owned by user; `/etc/sudoers.d/armada-build-user` grants noninteractive NOPASSWD
build access, validated with visudo. This is the intended privileged setup/secret
scanner contract inside the disposable VM, not root SSH or a verification bypass.
Production root-owned scanning (`sudo -n -- bash -c`) and Playwright --with-deps
must succeed; scan errors still fail closed.

Image creation copies the pinned Bun1.4.2 executable (not a symlink) into root-owned
`/opt/armada/runtime-bun/bun` with mode0555. Runner start uses that explicit path.
Shared baseline may select another project Bun and rewire global /usr/local/bin/bun
with #514's privileged-link fallback without changing the control runtime, including
after filesystem restore. Root-authorized builds can deliberately modify a VM;
this isolation protects against routine package-manager/global symlink rewrites,
not an adversarial user already granted sudo.

`probeModalSsh(provider,id,{script,githubToken?,timeoutMs?})` uses the same private
GitHub/public-key stdin framing and `bash -c` quoting as production core SSH. Script
stdout and raw stderr are never reported; only a strict ARMADA_BUILD_FAILURE phase /
exit marker may be surfaced. `runModalConformance` accepts optional goldenRecipe
`{script,scanCommand,githubToken?,timeoutMs?}` generated by the current production
core, runs the real SSH golden baseline and the privileged scan via runner exec,
and records that acceptance check only when supplied. Tool versions alone are not
build/scanner conformance. The executable fixture accepts the same private input.

Opt-in Linux/Docker `test/os-build-conformance.ts <isolated-current-core-src>` builds
the actual captured production image RUNs on MODAL_IMAGE_LOCK, provisions real sshd,
executes production baselineSetup (exposed only by the isolated reference harness)
against a user-owned Bun1.3.14/Playwright1.49.1 fixture, runs the actual generated
scanGoldenSandbox command through user SSH, and boots the private Bun runner after
global Bun changes. No repo-owned core source is modified. Root's real Modal recipe
probe must also supply the full production goldenScript/scan; checkout auth, cloud
networking and actual Modal behavior are not replaced by Docker or mocked SDK tests.

## SSH role under platform no-new-privileges (NNP)

Golden SSH returns trusted `username:'root'`; normal workers return `username:'user'`.
This is derived ONLY from server-owned Machine.golden, never a caller username or
labels. Golden sshd uses AllowUsers root / PermitRootLogin prohibit-password with
only the ephemeral key path; worker sshd uses AllowUsers user / PermitRootLogin no.
Password, interactive and forwarding paths remain disabled. ModalProvider.sshKey
verifies the preparation port returned the expected role. Optional shared
SshConnection.username defaults to user for other adapters; root supplies that union.

Modal applies NNP, so sudo in a user SSH session cannot elevate even with NOPASSWD.
Golden root SSH is already root and needs no setuid transition. Core514's secure
wrapper and this package's probe explicitly set HOME=/home/user before bash, retain
private token/public-key stdin framing and strict host-key pinning, then run the
production script. Core514 must normalize fixed /home/user repo/cache/tool ownership
after root setup so worker forks remain writable; never chown /opt/armada or its
private Bun. Normal runner HTTP exec remains user-scoped. Provider.exec now selects a private SDK
root-control path ONLY for an authorized, active Machine.golden under its lifecycle
lease. The unchanged provider-neutral mandatory scanner therefore runs as root on
goldens under NNP, without sudo elevation. Worker exec stays on the normal runner
journal/events/outbox path. No new privileged runner HTTP API is introduced.

SSH quiescence removes managed /run keys/config plus both user/root authorized_keys
paths. Root SSH children are fenced by the same trusted baseline/pidfd mechanism,
not merely by user UID or process names. Golden model/auth/MCP builder restrictions
are unchanged. No new privileged runner HTTP API or caller-selectable identity exists.

Actual `test/nnp-ssh-conformance.ts <production-core-src-reference>` starts real sshd
through setpriv --no-new-privs on the approved production image: worker login stays
user and sudo fails; golden key-only login stays root, HOME is /home/user, root apt
setup and the production scanner succeed. Opposite username labels cannot override
identity. Root's real Modal full recipe is still the final cloud acceptance gate.

## SSH and durable lifecycle

`sshKey({sandboxId,key})` returns `{sshEndpoint,hostKey,username}` matching main's secure
SSH executor. It validates an Ed25519 public key and provisions actual OpenSSH on
port2222 through Modal's raw TCP tunnel; SSH itself encrypts/authenticates traffic.
It generates a per-generation Ed25519 host key and returns its real public key for
strict pinning. Client authorizations expire after15 minutes. Password/agent/TCP/X11 paths are disabled; root key-only login is golden-only. Private host keys never leave the machine.
`prepareSsh` delegates to this exact same leased implementation: neither public
path can recreate authorization/host keys after checkpoint/scrub. Both require
current active admission and generation under the lifecycle lease.

Stop: durable checkpoint phase -> runner drain/auth scrub -> exact SQL ACK watermark
verification -> close SSH and all user-owned writers -> remove keys/auth audit ->
indefinite snapshot -> fenced SQL Image commit -> terminate/wait -> stopped commit.
The checkpoint watermark becomes the restored producer sequence base; it does not
restart at one. Fresh grants/bootstrap start a new physical generation under the
same logical ID. Snapshot/ACK uncertainty preserves the physical source and never
reports successful stop. TTL >24h is rejected, not clamped. Exited machines without
a current verified checkpoint report failure, not fictional disk recovery.

Goldens are immutable/provider-bound, use ttlMs:null and contain no managed model
credentials/sessions/bootstrap/host keys. Named snapshot deletion records a durable
tombstone first; source leases protect concurrent private/org fork reservations.
Images remain while any non-deleted fork references their lineage, including after
restore changes its current working Image. Last-fork deletion performs GC across
those references, with idempotent Image deletion/tombstone purge. collectGarbage()
retries interrupted GC explicitly. Server events remain readable after deletion.
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
fresh purge and keep native sessions. A legacy snapshot can be restored only with
a distribution supplying this fresh sanitization port; new golden snapshots retain
an explicit clean-history marker. Generic exec/resume never unseals a golden.

### Privileged process quiescence (root build descendants)

Before any user SSH/init/model/bootstrap work, owned composition captures root control
PID/start identities plus readable self PID/mount namespace evidence through the SDK and commits it
to `Machine.processBaseline`, scoped to exact physicalId/generation. Every physical
restore clears and refreshes this baseline. Metadata is nonsensitive server SQL only,
not an auth/cache file or log. A missing legacy/populated baseline is NOT reconstructed
after admission; snapshot fails closed and retains source.

Checkpoint preparation preserves PID1, the scrub exec's verified ancestors, root
kernel tasks and exact pre-admission PID/start control identities. Bootstrap can
introduce additional root platform/launcher processes, so the production adapter
seals that control set once after authenticated health and before publishing
active. The health responder PID is explicitly excluded: the private Runner still
owns the journal and must terminate. Positive managed cwd/FD links also veto a
control exception.

Current ancestry or session membership is never proof of birth ownership. A root
orphan adopted by a platform subreaper remains a writer if it was not recorded
before admission. No arbitrary root child, orphan or same-named executable gains
trust. Pending baselines become sealed with a valid health PID or legacy without
one; sealed/legacy/old baselines can never be rebuilt after admission. This uses
optional registry JSON and an additive private health PID, not a schema migration.

Pidfds anchor signals when supported; denied/unsupported pidfds fall back to
immediate PID/start revalidation in the SDK-selected physical sandbox. No PID1
namespace link is required. Freeze/kill sweeps target managed writers. Unknown
survivors still refuse with closed UID, ancestor/PID1 booleans, exe/comm match
classes, ownership role, state, managed-state evidence and bounded count (4096
means at least 4096). Inspection denial exposes only primitive/errno class. Raw
names, argv, paths and environment are never logged.

Only after quiescence are SSH credentials removed and, for golden purpose,
managed history unlinked. Opaque platform controls rely on verified pre-admission
provenance, not a claim that denied inspection proves an absence of writes.
Management credentials never enter the VM.

`captureProcessBaseline` and `quiesceSandboxProcesses` are production helpers, using
only public SDK exec and the pinned private Bun. `RunnerDistribution.captureProcessBaseline`
is mandatory for privileged production images; custom ports must meet the same
pre-admission capture contract. `test/process-scope-conformance.ts` is an opt-in actual
Linux/Docker test of those exact helpers, with real sudo/setsid root orphans sleeping
before reopening files, golden/recovery cleanup, preserved PID1 and namespace rejection.
It does not run the quiescer against the worker/host PID namespace. Root's existing
real Modal matrix remains separate evidence. The mandatory Linux
`test/checkpoint-process-conformance.ts` additionally proves checkpoint preparation
with unreadable PID1 namespaces and real seccomp-denied pidfds. Its native-pidfd mode
denies numeric kill, so fallback cannot silently satisfy the native proof. Actual
signal permission denial must still retain a positive survivor and refuse.

### Clean golden purpose versus recovery

Builder prompt/steer is refused before any runner/model call. After golden checkpoint
and exact server ACK verification, the owned snapshot preparer terminates SSH and
all user writers, waits for quiescence, and checks kernel FD/cwd links for unexpected
legacy/root handles in managed state. An open SQLite journal makes cleanup fail
closed. Only then does it remove `.armada-runtime` (journal, requests/process cache,
checkpoint seals and archived native sessions), legacy `.claude`/`.codex` state and
`.claude.json` backups before saving the Image. Repositories/tools remain intact.
Ordinary working recovery does **not** run that deletion and retains sanitized native
sessions. No `rm` runs while a managed/observed SQLite handle remains open. This
post-shutdown golden cleanup uses no new runtime checkpoint wire fields; #510's
sandboxId+generation retry fence is still required for restored/retried identity.

`SandboxInfo.physicalGeneration?:string` now carries the trusted Machine generation
once a physical ID is known, changes on restore, and never comes from labels or Linux
boot_id (which can be shared). No admitted in-place runner replacement is implemented;
if a supervisor adds one, it must rotate this epoch or report a fresh per-process
incarnation in authenticated health before #523 caches volatile preparation.

### Failure/resource provenance receipts

Launch/snapshot/stop failures after an authorized reservation throw ModalOperationError
with `receipt` and `details.resourceReceipt`; `modalFailureReceipt(error)` returns it.
The whitelist contains logical/physical IDs, deterministic name, durable/observed phase,
registryConfirmed, generation, Image/source/recovery references, binding and nonsensitive
management provenance. No request/env/MCP config, auth, labels, prompt text or raw SDK
cause is included. Known SDK Image IDs survive in a failure receipt even when their
SQL commit failed; new named snapshot IDs are also retained in Machine.snapshotImages.
The SDK response-loss case where no Image ID was ever received remains unrecoverable.

`provider.resourceReceipts()` inventories authorized target/context records (including
deleted history) without requiring a healthy Modal service. Call it **before** closing
a disposable fixture DB. `mergeModalResourceReceipts` preserves all observed Image IDs
when later durable reads lack an interrupted commit's metadata. Do not blindly delete
source/shared Images: retain their provenance and use normal reference-aware cleanup.
Production operation failures never auto-delete uncertain user data.

The opt-in harness captures reservation receipts even when await createGolden/fork
fails before assigning its result. Its finally block can therefore delete the specific
failed *disposable* booting machine, while checkpoint/snapshot/termination uncertainty
preserves the source. `onReceipt` lets root persist safe metadata as failures occur;
the executable emits merged receipt inventory on success/failure before fixture DB
closure, rather than losing Image references with its local database.

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

## Tests / opt-in coordinator conformance

Tests use real migrated PGlite and an injected public SDK at cloud boundaries.
They cover lost create response and pre-/post-create SQL crash deletion, ownership
mismatch, private ORG-golden forks with unchanged org management provenance, other
member denial, cross-scope image GC and scrub/save/SSH-provision interleaving.
Actual artifact tests copy main.js into an isolated directory before boot, exercise
private bootstrap/protected RPC/exec/checkpoint/journal reopen, and execute pinned
native binary versions. No workspace node_modules can mask a missing remote import.
This is not proof of real model/cloud parity or the runtime's full security gates.

`runModalConformance(provider,{models:true,launchEnv?})` is explicitly opt-in and
billable: toolchain/protected exec, actual ephemeral SSH authentication with strict
host-key pinning, golden SSH scrub, fork, concurrent real Claude/Codex turns,
checkpoint/stop/same-ID restore, both conversation resumes, snapshot deletion,
events after delete and cleanup. Checkpoint-uncertain sources are preserved.

Executable `bun packages/provider-modal/test/conformance-live.ts` accepts one private
stdin JSON object: scope, receiptDirectory, artifact `{base,apt,dist}`, ingestUrl,
listenPort, models, harness and an explicit tokenId/tokenSecret pair. No profile,
appName or managementAuthority is accepted: this tool never borrows a shared or
registered production App. The scope's AppID is replaced with a newly created
per-run AppID; workspace and environment remain explicit operator inputs.

Install the public Python Modal CLI (`pip install modal==1.6.3`) in PATH first.
The JS SDK 0.11.1 has no App.stop method. Only this opt-in tool uses the public
`modal app list --env ENV --json` and `modal app stop APP_ID --env ENV --yes`
commands. Tokens are passed in a private, minimal child environment, never argv;
CLI stderr is discarded and output is parsed/whitelisted. No profile/config file
is loaded (`MODAL_CONFIG_PATH=/dev/null`). Missing CLI/auth, malformed inventory,
nonzero exit or missing readback leaves cleanup incomplete. Public command shape:
[Modal app CLI](https://modal.com/docs/cli/latest/app); JSON columns were checked
against the public modal 1.6.3 wheel's `modal/cli/app.py`.

`receiptDirectory` must not exist. Keep this private local directory outside the
repository: its append-only numbered receipts record a UUID/run name and explicit
environment **before** creation, then the immutable returned AppID, creation
readback and final resource/image inventory. The private `registry/` PGlite database is
retained alongside the journal, including in-flight reservations on crashes. Never retry ambiguous creation or
infer ownership from a prefix, age, caller AppID or an empty inventory. Pending
creation requires operator investigation, not adoption or automatic stopping.
Do not edit receipts to authorize cleanup. Only this process's confirmed newly
created fixture is eligible for automatic finalization.

After exact provider resource/image cleanup, the tool requires successful
conformance, no preserved sources, fresh registry-confirmed deleted resources,
zero image records, and exact App readback with zero Tasks. It then stops only
that owned App and requires stopped/Tasks0 readback. A successful stop exit alone
is not terminal proof. Finally paths retain receipts and report incomplete on
any uncertainty, failed cleanup, stop failure or delayed readback; recovery
sources/snapshots must not be deleted merely to force a green result. The journal
is retained even when setup fails. No automatic retry or historical App reuse.

A deployed namespace is not active compute: Live/deployed with Tasks0 does not
mean a sandbox is still running, but it still needs explicit test-run retirement.
The historical shared `armada-provider-conformance` App
`ap-MQmau5HWSdX2t036SWIP7A` was verified stopped/Tasks0 by the operator after
receipt-based cleanup. **Do not reuse or revive it.** Production registered Apps
and unrelated resources are outside this tool's ownership. Future live tests
must create a new fixture. This change was validated with injected adapters only;
real operator validation remains a separate authorized action.

Supply HTTPS ingress first. Never save private input in argv/history/repository/
Image layers. Rebuild the current runtime artifact before live conformance.

### Privileged recipe OS evidence

The opt-in Docker probe completed with the approved production Node digest and
captured image RUNs, real user SSH and current production core baseline/scan:
Playwright --with-deps, noninteractive root scanner, user-owned fixture files,
project Bun1.3.14 and private runner Bun1.4.2 before AND after filesystem commit /
restore. A separate no-auth probe of the same production global npm Codex launcher
reproduced no-PATH exit127 and explicit-PATH exit0 (0.167.0), with required tools
found. These are Linux OS checks, not a claim that the coordinator's real Modal
model/conversation conformance has rerun; root must supply goldenRecipe from the
actual server core when running that cloud matrix.

### Golden exec NNP bridge

For server-owned golden rows only, Provider.exec verifies scope/authority/current
active admission and holds the lease through a one-command public Sandbox.exec root
supervisor. Command text is private stdin (never argv); HOME/PATH are explicit public
values and no model/provider/GitHub exec credentials are supplied. Synchronous timeouts
are 1–600 seconds (default60), stdout/stderr are drained concurrently and retained at
64KiB each, actual exit status and timeout/truncation flags are returned. Detached
requests fail closed. A sealed golden is not implicitly restored/unsealed. Workers
never take this path and retain normal runtime process/journal/outbox behavior.
The NNP OS fixture now runs the actual production scanner through this root SDK
helper and verifies nonzero status/stdout/stderr, command timeout and output bounds.
