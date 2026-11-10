# Launch templates, variables, and write-only secrets

Status: proposed design for [#906](https://github.com/The-Vibe-Company/armada/issues/906).
No feature, migration, production change, or scheduling system is implemented here.
The [owner decision](https://github.com/The-Vibe-Company/armada/issues/906#issuecomment-6769156110)
adds routine design coverage, with implementation after variables/secrets and templates.
Owner decisions in §7 precede implementation. Armada remains a launcher, not an
orchestrator ([#455](https://github.com/The-Vibe-Company/armada/issues/455)).

## 1. Existing boundaries and gaps

The following are implementation anchors, not claims that this proposal already works:

- [golden-config.ts](../../packages/core/src/golden-config.ts) rejects secret
  configuration; [golden-create-service.ts](../../packages/core/src/golden-create-service.ts)
  builds disposable environments and [golden-scan.ts](../../packages/core/src/golden-scan.ts)
  scans before snapshot. An environment is a provider-specific golden, not a template.
  Keep Boat and Modal IDs, immutable Modal workspace/environment/App bindings, and
  null Boat compatibility aliases for Modal.
- [vault.ts](../../packages/core/src/vault.ts), [credentials.ts](../../packages/core/src/credentials.ts),
  and [crypto.ts](../../packages/core/src/crypto.ts) already separate management and
  model credentials, encrypt with AES-256-GCM under ARMADA_ENCRYPTION_KEY, resolve
  user before org defaults, and support explicit account/version refusal rather
  than silent fallback. Generic application secrets must not become credential kinds.
- [connections.ts](../../packages/core/src/connections.ts) holds personal/org MCP
  connections and write-only authentication.
  [mcp-gateway](../../packages/mcp-gateway/src/gateway.ts) mediates upstream access.
  Select connection IDs, not just “Notion” or “Sentry”: two workspaces are two
  connections. Remote authentication should stay server-side.
- [launch.ts](../../packages/core/src/launch.ts) resolves a golden, forks with a
  harness environment, then runs git pull/init and harness setup. Existing model
  auth may use ~/.codex/auth.json; that exception is not permission to write new
  application secrets into checkouts. Today a fork environment is not a proven
  confidential transport for arbitrary secrets.
- [orchestrator-scoped-gateway.ts](../../packages/mcp-server/src/orchestrator-scoped-gateway.ts)
  accepts a strict child selection with pinned account/version, not generic owner
  authority. Extend the authority boundary; do not smuggle new fields through it.
- [work-preservation-collector.ts](../../packages/core/src/work-preservation-collector.ts)
  captures binary index/worktree patches, untracked nonignored files and unpublished
  git bundles. [work-preservation.ts](../../packages/mcp-server/src/work-preservation.ts)
  encrypts archives for storage. **Encryption is not secret removal:** a secret
  committed or written under an innocuous filename can be recovered today.
- Dashboard uses user-JWT RLS; the service-role control/MCP server must explicitly
  enforce the same visibility. Existing grant-revocation and token-column migrations
  demonstrate that RLS alone does not hide a ciphertext column. CLI is API-only;
  dashboard and iOS must consume the same safe DTOs, never implement decryption.

## 2. Proposed model and authorization

### Objects

A **template** is an immutable, numbered launch preset revision: environment
(golden ID plus provider and snapshot identity), exact connection IDs, harness,
model, effort, optional model-account ID, skills, and named variable/secret bindings.
It stores references, never secret values, inline auth, prompts containing secrets,
or provider credentials. Editing publishes a new revision using optimistic concurrency.
The template header has UUID, org context, owner, scope, name, current revision,
status and timestamps. Deletion tombstones it; historical revision IDs remain auditable.

A **variable** is readable configuration: UUID, owner/scope, name, value, version,
status. A **secret** has the same safe metadata but only value_enc in server storage,
plus version and optional expiry; no “reveal”, export, value hash, length, prefix,
or last characters in its DTO. Names and labels are not a place for secret values.
Use separate tables/DTOs for variables and secrets to avoid accidental SELECT * leaks.
Changing variable to secret creates a new object and warns that historical readable
copies cannot be recalled. Secret-to-variable conversion is forbidden.

Bindings map an environment key to exactly one object ID. No shell expansion,
interpolation, secret concatenation or implicit org/user key merging. Duplicate keys
are errors. IDs are stable across renames; delete/recreate never reuses IDs.
An org template must reference org resources, not its author's personal resources.
A personal template may reference personal resources and authorized org resources
within its org context. Personal does not mean an org admin can inspect it.

| Action | Personal resource | Org resource |
| --- | --- | --- |
| Create, edit, rotate, delete | Owner only | Admin only |
| Read variable or safe metadata | Owner only | Current members |
| Read secret value after write | Nobody through Armada, including owner/admin | Nobody through Armada |
| Attach to template | Owner for personal resources; org secret requires admin-approved binding to this template | Admin, org references only; explicit secret binding approval |
| Use to launch | Owner, with current membership and explicit org-secret template-use grant | Current members; secrets additionally require an admin-approved template-use grant for the actor |
| Change sharing | No in-place promotion; explicit copy and fresh secret input | No implicit personal copy |

Authorization is checked on both template and every resolved reference, even when
the service role bypasses RLS. A user's bot/service token has no greater rights.
Org admins may rotate/revoke and decide who can use a shared secret, not reveal it.
“Use without read” means **no read API**, not secrecy from someone who controls the
agent that receives plaintext. A compromised member can exfiltrate every org secret
they may launch with. Prefer narrow upstream credentials and explicit per-template
use grants. Proposed authoritative rule: require admin approval for each org-secret/
template binding and an actor (or explicitly approved member-group) use grant.
Recheck both at publish and admission, including personal templates; membership
alone never authorizes secret use. Revoking either grant advances its epoch.
Audit successful and denied launches. §7 asks the owner to approve this proposal,
not to choose between conflicting rules.

### Launch resolution and provenance

Resolve a specific revision (default current is resolved once before allocation).
A manifest records revision ID/hash, provider/golden/snapshot IDs, exact selected
connection/grant versions, resolved model-account ID/version, harness/model/effort,
variable ID/version **and copied readable values**, secret ID/version only, actor,
authorization epoch, and request idempotency key. Never record secret plaintext or
ciphertext in sandbox metadata, receipts, usage records, prompts or idempotency bodies.

An unspecified model account uses existing user-over-org resolution; persist the
resolved account binding. An explicit account never falls back. A template is not
a grant: validate model compatibility, membership, snapshot readiness and tool
authorization before allocation, then recheck mutable grants just before delivery.
A concurrent revoke invalidates admission; compensate by deleting/quarantining an
allocated machine, never running the agent. Versioned grants need a shared lifecycle
lease/epoch so revoke cannot race successful secret hydration.

Missing, disabled, revoked, expired, inaccessible or changed references fail closed
with a value-free diagnostic. Never silently pick a similarly named resource,
another provider, the latest snapshot, a different workspace or account. Rotation
increments the current secret version and invalidates existing revision bindings
until explicitly refreshed/published. Old revisions cannot recover retired values.
Live runs are drained as below. Retrying the same request returns its recorded
result, not a new launch with a new secret version.

Normal launch does not currently supply durable idempotency. Add an actor/org-scoped
launch_requests row with a unique client key, canonical non-secret request digest,
immutable resolved manifest, allocated sandbox ID and terminal result. Claim it
transactionally before fork; same key/body joins the existing request, different
body returns conflict. Bind taint and grant epochs to that request. On an unknown
provider allocation outcome, keep a reconciling state and refuse another allocation
until the original is found or conclusively absent; do not blindly retry. Recovery
workers revalidate authority before hydration. Retain a tombstone for expired keys
so expiry cannot silently turn a retry into a new launch.

Overrides in the first slice are prompt, TTL, size and repository only, validated
by existing policies. No arbitrary env/tool/account override to enlarge authority.
Future routines are covered in §8, per the owner decision; scheduler code, task
execution and routine UI are not implemented in this design-only ticket.

## 3. Secret threat model and guarantees

Trusted: control service with encryption key, service-role DB connection, provider
control plane, and sandbox OS administrators. A compromise of these can expose
plaintext; encryption at rest does not protect against a compromised decrypting server.
Untrusted: clients, org peers outside grants, repositories/init scripts, agent/tool
output, prompt-injected agents, external MCP endpoints, and retained sandbox state.

A process receiving a secret can read it, pass it to children, print env, write it
to disk, transform it or send it over the network. Same-UID processes and root may
inspect process state; environment variables are not a sandbox within a sandbox.
No design can both give an arbitrary coding agent plaintext and guarantee it never
leaks into its PR, transcript, archive, or external network. Clearly disclose this
at attachment and launch. For strong non-disclosure, keep the credential in a broker
and expose constrained operations instead (including tool permissions and destination
allowlists); a broker still exposes the authorized data/actions.

### Enforcement and proof matrix (requirements for follow-up implementation)

| Path / intended guarantee | Enforcement and failure behavior | Cheapest meaningful proof |
| --- | --- | --- |
| At rest: no readable secret in DB or user JWT | Existing encryptSecret/decryptSecret, random IV, ARMADA_ENCRYPTION_KEY only; revoke table defaults, explicit metadata column grants, RLS and service checks. Encrypt before persistence; no plaintext fallback | Real migrations on PGlite: anon, owner, peer, admin JWT column probes and service authorization; crypto round-trip/tamper tests |
| Write-only across create/update/list/errors | Server-only authenticated write endpoint, explicit safe response DTO, no body/APM/SDK request logging, cache-control no-store; reject without echo | Control API and MCP contract tests on success, duplicate, validation and backend errors, including SELECT return columns |
| Rotation/deletion/audit | Compare-and-swap version; revoke old version and invalidate grant epochs; delete ciphertext after invalidation. Audit actor/resource IDs, operation, version, outcome, time only, no value-derived fingerprint | Concurrent rotate/revoke/admit tests, audit serialization inspection, repeated delete; retain tombstone not ciphertext |
| Encryption-key rotation | Maintenance rewrap using same crypto scheme, inventory every encrypted table, verify before retiring old key; versioned key rollout needed before online rotation, never invent a second cipher | Disposable DB rewrap/rollback exercise; prove old key retirement and restore procedure |
| Transit: no plaintext argv, command journal, checkout file | TLS to control/provider, explicit confidential stdin/bootstrap channel with SDK tracing off; fixed commands, body not echoed or retained. Never interpolate shell commands, URLs, args or provider metadata; no env written to repository | Fake-provider request/exec-journal capture plus real Boat/Modal canary checks; provider unable to prove confidential transport is refused |
| Execution: least exposure | Run repo pull/init credential-free for these application secrets; hydrate only at final harness start via trusted supervisor, minimal allowlisted env, no inheritance into unrelated exec/tools. Children of the intended workload inherit by explicit policy; this is not protection from malicious code it runs | Runtime test inspects init, harness, child process and unrelated exec env with disposable canaries |
| Goldens/snapshots: Armada never intentionally embeds secrets | No template/application secret resolution during build. Only fresh isolated build recipes may produce eligible snapshots; mutable connected masters become permanently ineligible. Existing checkout credentials need scoped stdin delivery and cleanup before snapshot. Never snapshot/fork tainted machines; scans are defence in depth, not proof | Reject connect → arbitrary canary write → snapshot; inspect staging fork filesystem/history and builder credential cleanup |
| Preservation/recovery: no automatic secret-bearing archive | Mark machine tainted durably **before** delivery. Disable automatic collection and recovery export for tainted machines; value-free warning that unpushed work was not preserved. Never call today's collector on them | Stop/expiry/delete/recovery tests prove collector not called, including failed hydration and restart |
| Event/transcript/log/error/usage sinks | Register known values before delivery; redact at producer before persistence and before consumer/webhook delivery; allowlisted structured server errors and usage metadata, no raw SDK causes. Block output when redactor context unavailable | Canary in stdout/stderr, tool result, nested JSON, errors, webhook, dashboard/iOS DTO; verify stored and returned bytes, not just rendered text |
| PR bodies and external output | Never insert secrets into Armada-generated PR text or prompts. Block known-value output through managed paths; warn arbitrary agent git/network output cannot be guaranteed clean | Generated-body canary test; staging malicious prompt demonstrates and documents residual exfiltration risk |
| Child sandboxes | Resolve fresh from child-specific authority, intersect template with parent delegation policy; no copied env, grant, recovery disk or owner token | Child cannot name an ungranted secret/tool/template; sibling and stale-epoch negative tests |
| Resume/fork after revoke | Deny reuse of any tainted disk regardless of current grant; revoke gateway leases, stop/delete compute, fresh clean golden launch after new authorization only | Stop/resume, physical fork and stale token staging probes; DB epoch checks before provider mutation |

These are proposed release gates, not existing end-to-end guarantees. In particular,
Boat fork env and Modal bootstrap must be examined separately for provider retention,
logs and runtime env merging. Do not call a transport confidential merely because it
is stdin or TLS. Provider administrators can still read delivered secrets. If a
provider cannot exclude sensitive request bodies from journals, **do not enable raw
secret delivery on that provider**; use a server-side broker.

### Golden eligibility is a separate release gate

Today connectGolden permits mutable master setup and the snapshot scanner recognizes
selected token formats, not all application secrets. Before enabling secret-bearing
templates, add durable golden provenance/eligibility: connect irreversibly invalidates
master snapshot eligibility; snapshot must reject it even after reconnect/restart.
Rebuild in a fresh disposable builder from an approved, pinned recipe instead.
Legacy/unattested snapshots require rebuild, never grandfathering by name. No raw
application secrets are delivered to the builder. Existing GitHub checkout auth is
a distinct scoped credential: preserve its stdin-only transport, remove residual
auth, and prove cleanup in working tree/history before publishing. A malicious recipe
can embed an externally sourced secret; neither scans nor provenance prove absence
of arbitrary external secrets. Treat recipe authors as trusted environment publishers
and do not label a scan as proof against malicious publishers. Direct provider
operations outside Armada remain outside its enforcement boundary.

### Retention, revocation and redaction limits

Retain metadata-only audit for 90 days initially (owner decision); deny user updates,
restrict audit reads by org role/private ownership. Ciphertext deletion is immediate
in active DB, but backups follow retention and must never re-enable deleted grants
on restore. Document backup access/expiry and test restore tombstones. Delete is not
a promise to recall copies already delivered; upstream credential rotation is required
after exposure. A compromised sandbox's blast radius is its delivered credentials
and every action/data they authorize, not all vault contents.

Revoke first commits denial/epoch invalidation, then asynchronously confirms provider
termination with retryable metadata-only cleanup. While termination is unconfirmed,
report “revoked; termination pending”, not “secret removed”. Block new turns, exec,
resume and new admissions immediately. Revocation cannot instantly stop a running
process's direct network access; rotate/revoke upstream too. Retained provider disks
and backups need provider deletion/retention confirmation. Rotation applies the same
drain procedure; do not replace values in a live process and pretend old copies vanish.

Raw-secret first release therefore has **no preservation, recovery download, resume,
or fork** for tainted workloads. Do not silently lose work: warn before launch and
on stop. This is intentionally stricter than current preservation. Scanning patches
cannot prove absence in binary bundles or encoded data. Broker-only runs may retain
existing preservation subject to their own gateway-token handling. A later safe
archive design needs separate security review; it cannot claim perfect scanning of
malicious content.

Redact exact values longest-first and selected known token formats, across structured
fields and bounded stream chunk boundaries; account for JSON escaping and multiline
values. Keep redaction context for the lifetime of retained events, including retired
versions, in encrypted server-only storage with bounded access and retention. Refuse
replay if context is missing. Never put that context in client state. Existing redact()
in credentials.ts is useful but not a complete streaming/export policy. Encodings,
splits beyond supported buffering, hashes, screenshots and deliberate transformations
can bypass masking. Neither redaction nor an encrypted archive establishes “no leak”.
Armada's guarantee is against its own intentional serialization paths; agent-controlled
content remains untrusted. Users requiring absolute “never in transcripts/PRs” must
not grant raw secrets to an arbitrary agent.

### Validation and namespace

Proposed limits: keys match [A-Z][A-Z0-9_]{0,127}; 8 KiB UTF-8 per value,
64 bindings and 64 KiB total decoded launch values, with lower provider limits
enforced before allocation. Reject NUL, invalid UTF-8, duplicate keys, unknown fields,
URL credentials and secret values in metadata. No trimming of application values;
empty readable values are allowed, empty secrets rejected. Accept multiline secret
values via body/stdin only. Do not put raw values in validation messages.

Central server-owned reserved registry denies ARMADA_*, provider/harness/GitHub/
gateway auth keys and prefixes (including BOAT_*, MODAL_*, ANTHROPIC_*, OPENAI_*,
CLAUDE_*, CODEX_*, GH_*, GITHUB_*, MCP_*), and execution configuration such as PATH,
HOME, SHELL, ENV, BASH_ENV, LD_*, DYLD_*, NODE_OPTIONS, PYTHONPATH, SSL_CERT_FILE,
HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY. Compare case-insensitively for reservation.
Deny framework auto-exposure names NEXT_PUBLIC_*, VITE_*, PUBLIC_* for secrets.
A denylist is not a security sandbox: raw-secret admission must review binding keys
for selected runtime; test all managed credential names against the registry whenever
adding a provider/harness. No template can overwrite management/native auth.

## 4. Surface order and contracts

1. **Control API + remote MCP first.** Shared server policies and DTOs for template
   CRUD/publish, variable CRUD, secret set/rotate/revoke/delete and metadata list.
   Secret write accepts body only; response is ID/version/status, never submitted value.
   Resolve launch/options server-side with unusable references explained safely.
   Keep browser-safe @armada/core exports types only; crypto/I/O remain ./server.
   First MCP secret-write tool should accept a secure upload reference obtained through
   authenticated API, not raw values in tool arguments (which clients may transcript).
   Disable raw secret entry through conversational MCP until safe ingress is proven.
2. **CLI next.** API-only; proposed secret set/rotate reads stdin or an explicit file,
   never positional values or --value. No echo/debug body, no local secret cache.
   File is user-managed outside checkout; CLI neither copies it nor prints it.
   Output only metadata. Template launch uses revision ID, not local secret expansion.
3. **Dashboard.** Build navigation: Environments (goldens), Templates, Tools
   (connections), Variables (readable + secret tabs), Model accounts; Harness is a
   template selector rather than another credential store. Secret create/replace UI
   has no reveal control, clears input on completion/unmount, no analytics capture,
   no optimistic value cache or value in URL. Readable values explicitly labelled.
4. **iOS last.** Same API safe DTOs and permissions, launch/use and metadata first;
   no plaintext persisted in app state restoration, logs, crash reports or clipboard.
   Secret input later only after a secure-entry/no-telemetry audit. Never native decryption.

All surfaces distinguish revision mismatch, unavailable grant and pending revocation
without exposing private names. Routine surface contracts are in §8; no routine implementation or launch UI redesign here.

## 5. Delivery sequence (proposed follow-up issues, not changes in this PR)

Each row is independently reviewable. Real-provider checks use disposable staging
orgs, least-privilege canaries and both supported providers where applicable; never
production credentials. A failed security check disables that capability/provider.

Delivery order is **variables/secrets → templates → routines**. Complete the
variable/secret safety gates before enabling template secret delivery; broker-only
or readable-only capabilities may ship earlier without implying raw-secret readiness.
Surface order within each stage remains API/MCP → CLI → dashboard → iOS.

| Order / issue | Small scope and acceptance criteria | New migrations needed | Real-provider staging check |
| --- | --- | --- | --- |
| 1. Readable variables and write-only vault ingress | Smallest useful slice: shared API/MCP metadata and secure writes, variable reads, secret set/rotate/revoke/delete; no sandbox delivery | readable_variables, application_secrets with server-only value_enc, version metadata, audit, revocation epochs, upload-reference hashes/expiry; explicit RLS/column grants | Disposable staging write/read/rotate/delete, cross-org denial; no secret response or provider traffic |
| 2. Secret runtime safety gates | Taint-before-delivery, confidential transport, final-start hydration, redaction/replay, snapshot eligibility, preservation/recovery/resume/fork denial and revoke cleanup; provider capability stays disabled until proven | launch secret-version bindings, taint, golden provenance/connect invalidation, lifecycle epochs/leases, cleanup state, encrypted redaction context | Boat + Modal disposable canary harness: argv/journals/files/output, stop/expiry/revoke/restart/fork; no archive, stale admission or connect/write-canary/snapshot. No user-facing raw delivery yet |
| 3. Variable/secret management surfaces | CLI stdin/file only, dashboard replacement not reveal, iOS safe metadata first; no local cache or analytics values | None; separately reviewed server mutation functions only if needed | Real CLI/browser/device staging writes and invalid requests; inspect network/log/crash payloads for canaries |
| 4. Template presets and readable bindings | Immutable environment/tools/model revisions, shared API/MCP launch, explicit readable values, durable request claim before fork; missing references fail closed | templates/revisions, revision bindings, launch_requests/immutable manifests/results, actor/org key uniqueness and digest; explicit RLS/grants and revision CAS | Boat + Modal presets with two Notion workspaces; lost response, duplicate key, changed body and unknown provider outcome prove no duplicate allocation |
| 5. Secret/tool template grants and child authority | Admin-approved org-secret/template binding and actor/group use grants, server-held remote MCP auth; opt-in raw delivery only after slice 2; fresh child admission | connection/grant-version bindings, template-use/delegation grants; explicit RLS/grants | Sentry allow/deny; unapproved member/personal template rejected; revoked child gateway denied; canary template launches repeat slice 2 checks |
| 6. Template surfaces | CLI publish/use; dashboard Build > Templates and launch warnings; iOS consumption; safe revision mismatch diagnostics | None unless a separately reviewed dashboard mutation function is needed | Real staging CLI/browser/device publish/launch/revoke on both providers; no secret DTO or client persistence |
| 7. Routine model and manual occurrence | §8 ownership/revisions/delegation; run-now uses same admission/idempotency/outcome path; no scheduler yet | routines/revisions, occurrence claims/results, delegation epoch bindings, private/org RLS and grants | Manual staging occurrence on Boat + Modal, duplicate request, removed owner and revoked secret fail safely; outcome links to exact prompt |
| 8. Routine scheduler and admission limits | Durable timer worker, occurrence claims/fencing, missed/overlap/pause policies, concurrency/spend reservation, native-account exclusivity | next_due/anchor/interval, worker leases/fences, concurrency and budget reservations/ledger, unique occurrence index | Two staging workers, crash/restart and lost response: no duplicate; missed/overlap recorded, pause fence wins, two routines sharing native account cannot allocate twice; budget race rejects loser |
| 9. Routine outcomes and unattended recovery | Outcome observer, bounded retries, value-free reasons, unknown-outcome reconciliation and cleanup; no replay of side-effecting prompts | outcome cursor/lease, terminal reason/cleanup state and notification outbox if needed | Staging auth expiry, usage limit, provider move, timeout, revoke during allocation and observer restart; over-50-page history, stalled cursor and raw-error canary prove unknown rather than false success/no secret reason; physical cleanup confirmed |
| 10. Routine surfaces in Run | API/MCP then CLI, dashboard Run > Routines, iOS; safe configure/pause/run-now/history/outcome access | None beyond 7–9 | Real staging UI creates every-X-hours routine, pauses/resumes, displays missed/busy/budget/failure and exact redacted run outcome; cross-org/private access denied |

Implementation tickets must name actual new timestamped migration files when scoped;
never edit applied migrations or apply migrations as part of this design review.
No new tests are proposed just to assert document wording; behaviour tests belong
to the slice that implements each guarantee.

## 6. Product comparison

Checked against primary documentation on 2026-11-10:

- [Vercel Config and Secret types](https://vercel.com/changelog/environment-variables-now-use-config-and-secret-types)
  separate readable configuration from values members cannot retrieve after saving.
  Adopt the explicit distinction, not a “masked in UI” checkbox. Its
  [environment scoping](https://vercel.com/docs/environment-variables) is analogous
  to explicit launch bindings, not justification to copy secrets into golden builds.
- [GitLab CI/CD variables](https://docs.gitlab.com/ci/variables/) distinguish masking
  from hiding and offer scoped variables. Adopt that terminology distinction:
  hiding prevents subsequent UI reads, masking filters logs, neither protects
  against malicious code running with a variable.
- [GitHub Actions secrets](https://docs.github.com/en/actions/concepts/security/secrets)
  provide scoped encrypted secrets and output redaction; GitHub explicitly warns
  transformations make automatic redaction unreliable. Adopt narrow grants and
  the warning, not a promise that a coding agent cannot leak its own environment.

These are UX/security comparisons, not evidence of Armada provider conformance.

## 7. Owner questions, with recommendations

1. What did “soit Modal, soit Boat, soit ouvert” mean? **Ask; do not infer a third
   provider or “any provider”.** Until clarified, support explicit Boat/Modal
   golden selection only, one snapshot per provider.
2. Approve Build naming? Recommend Environments + Templates as separate entries,
   Tools, Variables and Model accounts; harness/model/effort live inside templates.
3. Is “use without read” acceptable when the member controls agent code?
   Recommend brokered MCP by default, explicit warning/opt-in for raw secrets.
   If secrecy from an authorized launching member is required, reject raw injection.
4. Can raw-secret runs forgo automatic preservation/resume/fork? Recommend yes for
   the first opt-in release, with launch warning; otherwise defer raw-secret delivery.
5. Should every org member use every shared secret? Recommend admin-approved
   per-template grants, least-privilege upstream tokens and membership rechecks;
   private resources remain owner-only even from admins.
6. Should rotation automatically update old templates? Recommend no: fail closed,
   publish refreshed bindings, stop affected raw-secret runs and rotate upstream.
7. Is 90-day metadata audit retention suitable, and what backup retention is required?
   Recommend 90 days initially with explicit backup expiry/restore denial policy;
   do not claim deletion erases provider or third-party copies.
8. Should model accounts follow the launching user or be pinned? Recommend existing
   user-over-org defaults when unspecified, explicit ID/version when selected, and
   persist the resolved binding. No silent fallback.
9. Confirm API/MCP → CLI → dashboard → iOS order? Recommend yes. Routines are
   confirmed by the owner, after variables/secrets and templates; approve §8 defaults
   (especially principal, missed-run and concurrency policy) before implementation.


## 8. Routines in Run: template + task/prompt + every-X-hours schedule

The owner confirmed routines will be built after variables/secrets and templates.
A routine is a versioned consumer, not a new source of authority: ID, org context,
owner/execution user, private/org scope, approved delegated-use grant, pinned template
revision, non-secret task description and prompt, bounded schedule/time zone, status,
and concurrency policy. No plaintext or encrypted secret payload is stored in its
prompt, task or schedule; only template references. The API cannot detect every
secret a user types, so warn, reject known values and never auto-expand secrets into
stored text. Inputs are not passed through command-line shell expansion.

Recommend org routines are created/edited/enabled by admins; personal routines by
their owner. Viewing follows private owner-only/org membership rules. Neither org
visibility nor admin authorship grants execution rights: every occurrence executes
as the explicit user with a separately approved, scoped, revocable delegation,
never as the scheduler's service-role identity. Changing owner, template, prompt,
schedule or grants creates a revision and pauses until reapproved. No “run as any
org member” fallback. A member leaving the org, user disablement, revoked delegation,
missing resource or changed secret version pauses the routine with a safe diagnostic.

At each occurrence, claim a durable unique (routine ID, revision, scheduled UTC
instant) record and derive its launch idempotency key. Reuse §2 launch admission:
recheck current user/membership, template-use grants, connection/account versions,
secret epochs and environment eligibility before allocation and hydration. Pinning
a revision never preserves authorization. Duplicate ticks, worker restart, timeout
and unknown provider outcome reconcile the same occurrence; never launch twice.
Persist result/sandbox IDs and value-free errors only.

### Scheduler placement and reliability

Recommend a dedicated control-plane timer/observer worker alongside the MCP/control
service, using the same durable PostgreSQL store and server admission service.
Never run the scheduler inside an agent sandbox, client, provider cron, or browser.
Multiple worker replicas are safe only with transactional due-row claims, expiring
leases and monotonically fenced writes; a stale worker cannot commit over a new
claim. DB time is the scheduling clock. Persist next_due and reconcile due rows
after restart, not only in-memory timers. No particular queue vendor is required.

The first schedule is an integer interval X >= 1 hours from an explicit UTC anchor.
It measures elapsed time, not local wall-clock recurrence; IANA time zone is display
metadata only, so daylight saving does not produce duplicate/missing intervals.
Changing interval/anchor publishes a revision, pauses for approval and cancels
unclaimed old-revision occurrences. Do not add arbitrary cron semantics initially.

At-least-once ticks are expected; **at-most-one admitted allocation per occurrence**
uses §2 request claims and provider reconciliation. This is not a promise of
exactly-once task side effects. Recover expired worker leases by examining the
existing launch/result/provider identity before any mutation; never infer absence
from a timeout. Unknown outcome remains reconciling and holds capacity/budget.
Already-started prompts are never automatically resent.

Recommended policies:
- One active occurrence per routine, no overlap or backlog. A tick while a previous
  run is active/reconciling records skipped_overlap, not a deferred duplicate task.
- A due tick more than five minutes late records missed_schedule; collapse long
  outages into a counted missed interval range and advance to the next future tick.
  No catch-up burst. Manual run-now is a new explicit occurrence, still limited.
- Pause/delete atomically advance schedule epoch and prevent new claims/admission;
  recheck that epoch immediately before allocation and hydration. Pause does not
  stop admitted runs: expose a separate stop-active action. Resume recomputes the
  next future tick and never backfills. Delete tombstones history.
- Bound per-run TTL by existing provider policy and routine limits; stop when TTL
  expires and confirm physical exit. A stopped sandbox is not proof of task success.
  Raw-secret runs retain §3 restrictions: no archive, resume or fork.
- Expose worker heartbeat, oldest due age, reconciliation backlog and cleanup-pending
  metrics without prompts/secret values; alert on stale worker or unresolved allocations.

### Concurrency, native accounts and spend admission

Apply the same atomic admission to scheduled, manual run-now and retry requests.
Reserve routine, actor and org capacity and a per-day maximum-start allowance before
allocation; defaults are one active occurrence per routine and no more than 24 starts
per routine per UTC day. Owner/admin must explicitly configure org concurrency,
daily spend/start caps and per-run TTL/size before enabling. These caps cannot enlarge
existing provider/org limits; children consume the same budget, not a bypass.

A native subscription account may own **one sandbox at a time**, including manual
launches, other routines, orchestrators/children and retained native-account ownership.
Use the existing native credential ownership/admission path, not a scheduler-local
mutex or a copied login. Resolve/pin account ID/version explicitly for unattended
runs before enablement; do not depend on a mutable “current default” at each tick.
Do not fall back to another account or steal ownership when busy. Record
credential_busy, skip this occurrence and try only the next scheduled occurrence;
no unbounded queue. Expired activity/worker lease alone is not evidence that native
ownership or compute was released: reconcile using the existing ownership and
provider-exit rules. Never clear native owner state just because a prompt ended.

Reserve a conservative compute allowance from size/TTL plus configured model usage
allowance against the org and routine daily budget; serialize concurrent reservations.
Settle against provider usage with an idempotent ledger; hold reservations when usage
or allocation outcome is unknown. If no usable rate/usage estimate or sufficient
allowance exists, fail closed with budget_unavailable or budget_exceeded. Enforce
available model token limits and stop policy, but label estimated cost as estimated.
Subscription billing, delayed metering and in-flight requests prevent a guaranteed
hard currency cap without upstream enforcement. Communicate possible overrun; use
upstream quotas for a strict financial ceiling. No secret or prompt in usage ledger.

### Unattended authorization and secret resolution

Enabling a routine grants narrowly scoped launch delegation to its execution user;
it is not a cached human session, copied vault contents or a permanent authorization.
The scheduler submits occurrence metadata only. The control service rechecks current
identity/membership and every binding/grant epoch at run time, then decrypts and
delivers only authorized values through §3 transport. No secret in scheduler queue,
job payload, routine prompt, outcome, notification or worker logs. Broker connections
remain server-held. An expired tool OAuth grant or native login may need a human to
reconnect: pause with auth_required; never bypass expiry or reuse retired auth.

Revoking a secret/delegation or removing the execution owner pauses future runs and
invokes §3 drain/termination for affected active raw-secret runs. A changed variable,
secret/account version or template reference requires explicit revision refresh and
approval, not silent value substitution. Org routines owned by a departed member do
not “run as admin”: an admin must choose an eligible new execution user, obtain fresh
delegation and reapprove references. Personal routines cannot be taken over by admins.
Admin status does not permit reading the secret during repair.

### Run records, outcome and failure reasons

An occurrence records routine ID/revision, schedule epoch, UTC due/claim/start/end
times, trigger (scheduled/manual), initiating actor and execution principal, request
key, admission epochs, immutable template/launch manifest ID, allocation identity,
sandbox ID, prompt/conversation IDs, model-account ID/version, safe variable provenance,
secret ID/version only, budget reservations/usage references, attempt/reconciliation
state, observer cursor and value-free reason. Prompt/task belongs to the authorized
routine revision, never copied into generic usage/audit fields. Read permission follows
the intersection of routine visibility and sandbox-interior authorization; org routine
visibility must not reveal a private sandbox's transcripts. Tombstones preserve safe
history without preserving secret payloads.

Proposed states: due → claiming → admitting → launching → running → finished/failed/
interrupted/cancelled, with missed/skipped terminal states before launch. Unknown
allocation or prompt status remains reconciling/unknown, never fabricated success.
A durable observer resumes from its cursor and records an outcome through
[turns.ts](../../packages/mcp-server/src/turns.ts) and
[promptOutcome](../../packages/core/src/outcome.ts), not by assuming process exit,
sandbox status or last event text means success. Reuse existing auth_expiry/usage_limit semantics, but **not** the current helper
unchanged: outcome.ts has a 50-page scan budget and may return finished after a
partial scan; generic provider failure reasons may contain raw text. Slice 9 must
introduce a complete-evidence boundary before routine use. Persist a per-prompt
observer cursor and terminal evidence transactionally; exhausting a page budget,
a stalled cursor, unavailable history or a gap yields outcome_unknown/reconciling,
never finished. Confirm terminal prompt state and complete relevant failure-event
coverage (or equivalent provider terminal proof) before recording success. Map all
reasons to the allowlist and redact before any persistence, API DTO or notification;
never forward raw provider/SDK reasons through turns.ts into routine records. “Finished” means the agent turn ended, not
that its business task succeeded; task assertions require a future explicit contract.
Link the exact sandbox/prompt for redacted logs and artifacts under normal access
rules. Notifications use safe IDs/status/reason, never raw output.

Reason codes must distinguish: missed_schedule, skipped_overlap, paused,
owner_unavailable, delegation_revoked, reference_unavailable, version_changed,
secret_revoked, auth_required, credential_busy, concurrency_limit, budget_exceeded,
budget_unavailable, provider_unavailable, allocation_unknown, init_failed, usage_limit,
auth_expiry, interrupted, ttl_expired and outcome_unknown. Map backend errors to this
safe taxonomy without serializing SDK messages. Configuration/auth failures pause
future ticks; busy/capacity/budget skips are visible and retried only at the next tick.
Transient pre-allocation failures may retry at most three times within the five-minute
lateness window using the **same** occurrence/request, with backoff and fresh admission.
If allocation might have happened, only reconciliation may proceed. No automatic retry
of a started/finished/interrupted task; a human-requested rerun is a new audited
occurrence and warns that side effects may repeat. Preserve original task outcome
separately from cleanup_status/termination_pending; a cleanup failure cannot hide
revocation risk or be relabelled a successful cleanup.

### Surfaces and delivery

API/MCP first: safe routine CRUD/revision approval, enable/pause, run-now,
stop-active, occurrence list/status/wait and redacted outcome links; secure secret
ingress stays separate. CLI next: equivalent routine commands, schedule every X
hours and bounded limits, no secret value arguments, no long-lived scheduler token
on the workstation. Dashboard **Run > Routines** then exposes template/revision,
task/prompt, interval, execution principal, grants and budget preview; next run,
pause/stop distinction, active/missed/skipped history, failure/reconnect actions and
exact sandbox outcome. iOS last uses the same DTOs/access rules for launch/history/
pause and notifications; no background mobile scheduler or secret persistence.

Slices 7–10 in §5 deliver model/manual execution, scheduler/limits, outcome recovery
and surfaces separately, after variables/secrets and templates. Each includes a
disposable staging check; no routine code or migrations are added in this PR.
