# Launch templates, variables, and write-only secrets

Status: proposed design for [#906](https://github.com/The-Vibe-Company/armada/issues/906).
No feature, migration, production change, or scheduling system is implemented here.
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
| Attach to template | Owner, if every reference is usable | Admin, org references only |
| Use to launch | Owner, with current membership for org references | Current members |
| Change sharing | No in-place promotion; explicit copy and fresh secret input | No implicit personal copy |

Authorization is checked on both template and every resolved reference, even when
the service role bypasses RLS. A user's bot/service token has no greater rights.
Org admins may rotate/revoke and decide who can use a shared secret, not reveal it.
“Use without read” means **no read API**, not secrecy from someone who controls the
agent that receives plaintext. A compromised member can exfiltrate every org secret
they may launch with. Prefer narrow upstream credentials and explicit per-template
use grants if broad membership is unacceptable; recommendation: require admin opt-in
for each org secret/template binding, and audit launches.

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

Overrides in the first slice are prompt, TTL, size and repository only, validated
by existing policies. No arbitrary env/tool/account override to enlarge authority.
Future routines can store template revision + prompt + schedule externally; no
scheduler, task model or routine UI is part of this ticket.

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
| Goldens/snapshots: Armada never intentionally embeds secrets | No secret resolution during golden build; no snapshot/fork of secret-bearing machines, including provider-native paths exposed through Armada. Golden scans remain defence in depth | Fake-provider rejection before snapshot, then staging inspect fresh fork filesystem/history |
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
without exposing private names. No scheduled routines or launch UI redesign here.

## 5. Delivery sequence (proposed follow-up issues, not changes in this PR)

Each row is independently reviewable. Real-provider checks use disposable staging
orgs, least-privilege canaries and both supported providers where applicable; never
production credentials. A failed security check disables that capability/provider.

| Order / issue | Small scope and acceptance criteria | New migrations needed | Real-provider staging check |
| --- | --- | --- | --- |
| 1. Template presets + readable variables | Smallest useful slice: immutable revisions, explicit tools/environment/model, readable config only; shared API/MCP authorization, no raw secrets. Missing/version-changed refs fail before allocation; no inherited tool defaults | templates, template_revisions, readable_variables and revision bindings; explicit grants/RLS, revision CAS and metadata provenance | Boat + Modal launch two presets into different test Notion connections; verify tool isolation and chosen model/env; no app secrets |
| 2. Write-only vault ingress | API secure writes, versioned metadata, encrypted storage, RLS/column tests and audit; secure MCP upload refs; no delivery yet | application_secrets (value_enc server-only), secret_versions/metadata, audit, revocation epochs and upload-reference hashes/expiry; no JWT ciphertext grants | Disposable staging write/rotate/delete via API and MCP; inspect API/provider traffic to prove nothing reaches a machine |
| 3. CLI configuration | stdin/file ingestion, template publish/use, safe errors and no local caches; tests inspect captured argv/output | None beyond 1–2 | Use source/built CLI against staging, invalid request and rotation canaries; no value in terminal logs |
| 4. Broker-first grants and child authority | Server-held remote MCP auth, explicit connection selection, narrowed per-template use, fresh child authorization; no expansion to generic owner authority | revision connection/grant-version bindings and template-use/delegation grants as needed; all explicit RLS/grants | Sentry allowed/denied presets; two Notion workspaces; revoked child cannot reuse gateway token |
| 5. Raw-secret lifecycle safety, then opt-in delivery | Provider transport proof, final-start hydration, redaction/replay gates, taint-before-delivery, preservation/recovery/resume/fork denial, revoke races and physical cleanup. No opt-in until every matrix gate passes | launch secret-version bindings, taint flag, lifecycle epochs/leases, cleanup state, encrypted redaction context with retention | Boat + Modal canary across env/argv/journals/files, malicious env output, stop/expiry/revoke/restart/fork; assert no archive and no stale admission. Disable unsupported provider |
| 6. Dashboard management | Safe metadata UI, secret replacement not reveal, org/private checks, launch warnings and revision preview; browser tests at user boundary | None; server-backed mutation functions only if required, separately reviewed migration | Real staging browser create/publish/launch/revoke; inspect network, analytics and error payloads for canaries |
| 7. iOS consumption | API parity for selection, metadata and revocation state; no client decryption or persisted secret input | None | Staging device launch with both providers, reconnect after revoke; inspect crash/state-restoration logs |

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
9. Confirm API/MCP → CLI → dashboard → iOS order and defer routines entirely?
   Recommend yes; routines may later reference revisions without changing authority.
