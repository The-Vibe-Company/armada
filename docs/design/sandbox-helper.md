# One sandbox helper, not another harness supervisor

Decision proposal for [#908](https://github.com/The-Vibe-Company/armada/issues/908),
2026-11-10. **Yes: install one small, inert, versioned Armada helper in every
new or rebuilt golden, on Boat and Modal. Use on-demand commands and existing
runtime supervision; do not add a universal always-on daemon.** A GitHub-only
resident broker remains justified where the existing security boundary requires
it. One distribution does not mean one credential with all powers.

This document changes no feature code, gate, migration or deployment. Owner
approval of installing software is not approval of every authority below.
Armada remains a launcher, not a scheduler, merge queue or deployer.

## Evidence and what this decision revises

Read with [the v2 specification](https://github.com/The-Vibe-Company/armada/issues/455),
[managed GitHub runtime](../github-runtime.md),
[GitHub delivery alternatives](../github-delivery-options.md), and
[the earlier reporter decision](sandbox-reporter.md).

The #908 coordinator reports static owner-token copies failing at shared rotation,
Boat session `cost-state` usage (#883), a requested/observed model mismatch (#890),
and preservation returning `unavailable` without a stage (#902). These are supplied
observations, not experiments performed for this design. Modal already has usage
in its managed runtime. [PR #899](https://github.com/The-Vibe-Company/armada/pull/899)
is **open, not merged** as of this revision: its pinned, checksum-verified golden
tool provisioning is an implementation prerequisite for slice 0, not functionality
already available on main or an existing general helper installer. This design
can merge independently; implementation must recheck that prerequisite.

The reporter document correctly preferred one-shot extraction over a reporting
**daemon**. That remains the smallest reporting solution. Its narrower conclusion
is insufficient for the combined problem: server-side exec cannot intercept the
next Git credential request in a running native shell, and a pre-stop pull can
fail at the very transport needed to recover work. We now recommend a common
installed execution surface plus a private push path, not a second supervision
stack. A permanent heartbeat daemon alone solves neither missing usage sources
nor forced-stop data loss.

The existing managed GitHub runtime is default-off pending #822/#825/#830
validation. #881 manual repair and default-off legacy next-prompt preparation
are bridges, not credential-at-use renewal. This proposal does not enable either.
The delivery-options document still recommends publish-by-bundle as the safer
long-term managed delivery target; the owner has not selected it. This proposal
recommends the existing broker as a bounded compatibility first slice, explicitly
subject to owner acceptance of its user-token exposure. Do not build a second
refresh implementation or silently change the GitHub actor to the App.

## Jobs, in priority order

| Priority | Helper responsibility | Replaces / reuses | Limits |
| --- | --- | --- | --- |
| 1 | Fresh GitHub access when HTTPS Git or supported gh commands need it | Finish/reuse gated broker, credential helper, wrappers, server resolver and refresh CAS; supersedes manual refresh/next-prompt repair only after validation | No owner refresh token in guest; not arbitrary GitHub proxying; local Git never requires Armada |
| 2 | Per-turn measured usage and observed model | Boat bounded native-file parser/hook in #883; reuse Modal driver reports and existing accounting projections | Requested and observed model separate (#890); unknown/partial is not zero; cost is a versioned estimate, not an invoice |
| 3 | Readable readiness/failure causes and sparse liveness | Typed observations supplement provider polling and opaque `unavailable`, not replace canonical lifecycle | Closed stage/reason codes; heartbeat silence is unknown, not death; no automatic restart/stop |
| 4 | Flush work preservation from inside before controlled stop and at safe turn boundaries | Reuse #747 collector/encryption/storage and fix #902 stage diagnostics; supplement server pre-stop pull | Recovery archive, not publish; no auto-commit/push; abrupt kill can lose uncaptured work |
| 5 | Later explicit variable/secret delivery (#906) | Reuse encrypted vault resolution; no guest vault/list API | Separate future authorization review, exact assigned keys and revisions only; not enabled by report or GitHub grants |
| 6 | Skills installation status and explicit updates | Reuse #899 Skillpack provisioning and verified pinned receipts | No autonomous latest-version updater or new registry credentials; installed receipt does not prove usage |

Usage parsing must identify the admitted sandbox generation, conversation, turn
and native session through a proven binding, not the newest file or guest-chosen
account ID. Validate Boat Claude `cost-state` and `api-request` against actual
installed versions; Codex needs its own proven source. Preserve per-model usage,
source/schema version, observation time, cumulative/delta semantics and partial
coverage; deduplicate retries and counter resets. Subscription windows remain
account-private under #884, never inferred from turn tokens. Do not copy raw
session lines, transcripts, prompts, tool results or auth caches to the API.

Preservation is an explicit **separate artifact lane**: encrypted bundles/dirty
recovery under existing size and retention policy, not telemetry that happens to
contain files. Server grants an upload slot with a byte cap, digest and operation
ID for this sandbox/generation only; no bucket listing, arbitrary URL, overwrite
of others' objects or automatic publication. Finalize only after durable storage
ACK. Ambiguous upload retries reconcile the operation ID. #902 must first locate
which boundary fails; pushing from inside is not evidence that the collector or
storage now works. Keep server-side collection as fallback, avoid duplicate
archives for one capture, and expose stage (`collect`, `encrypt`, `upload`, `ack`)
and closed reason without filenames or raw stderr.

## Shape: commands plus existing supervision

A single pinned package exposes conceptual commands `github`, `report`,
`preserve`, and `diagnose` (names are not a promised public CLI).

- Git/gh invoke the existing private broker on demand. Reuse its resident process
  on Boat and its integration inside Modal's Runner; do not replace it with an
  unsafe direct HTTP token-printing shell command. Retain synchronous redaction
  registration, private socket activation, revision ordering and caller UID
  handling. Any later removal of the broker needs a separate security proof.
- Boat uses supported native turn hooks to write bounded sanitized records and
  run a short-lived flush. Prove the hooks execute in Boat's headless harness;
  otherwise server turn-end/pre-stop exec invokes the same extractor. Neither
  path assumes ownership of Boat's native launcher or starts another app-server.
- Modal calls the same schemas/collection library from the already-running
  runtime. Do not start a second journal, driver, uploader or heartbeat loop.
- Heartbeats piggyback active runtime/report activity. On Boat, use existing
  server/provider polling plus last helper contact until an existing supervised
  hook can supply sparse active-turn observations. No promise of idle push
  heartbeats; this is not reason enough to introduce a new daemon.
- One-shot work has bounded deadlines, queue size and retries with jitter. Local
  edits, commits and inference continue when reporting fails. Do not continuously
  scan home directories or run inference to collect usage.

Outages: network-authenticated Git/gh fails with a sanitized bounded error while
local Git remains usable. Do not silently fall back to stale static tokens or
replay an uncertain push. Optional reports spool with caps (proposed 1 MiB/24h,
coalesce heartbeat samples before dropping usage; report gaps). Preservation uses
its own existing archive cap and durable receipt, not that telemetry spool. Show
stale/partial/unavailable status rather than fabricated success. Existing native
output redaction may apply backpressure during broker outage as documented in
`github-runtime.md`; this is a known limitation, not uninterrupted-output support.
Recovery of reporting must not terminate the harness or require owner token repair.

## Security contract: workload capabilities, not an Armada login

The guest is untrusted, including a prompt-injected agent and anyone with guest
exec/root. File modes and sockets reduce accidental disclosure; they do not turn
a shared VM into a trusted enclave. Assume guest-resident capabilities and issued
GitHub leaves can be stolen. Authentication attributes a report, not its truth.

### Scope and enforcement

Use **purpose-separated grants**, not a general `ARMADA_TOKEN`, provider key,
MCP delegation token, Runner admin grant or Supabase session:

| Grant | Allowed | Explicitly forbidden |
| --- | --- | --- |
| GitHub | Existing broker acquisition for persisted allowed repositories/operations as original owner | Refresh secrets, vault, arbitrary host/API proxy, owner override, new repositories |
| Report | Append bounded allowlisted observations for admitted own turns | Reading other reports/accounts, lifecycle mutation, native-auth publication, commands |
| Preserve | Upload/finalize one authorized own recovery artifact | Publish/merge, list/download artifacts, arbitrary storage destinations |
| Later variables/skills | None in the first slices | Broadening another lane to read secrets or install arbitrary software |

Server derives org, original owner, membership and GitHub connection epochs,
source golden/repository allowlist, provider/backend and physical generation from
trusted persisted state. Modal additionally binds immutable workspace/environment/
App. Guest payload cannot choose these or a usage credential/account mapping.
Every request checks current active membership, lifecycle, deadline, generation,
purpose, audience and operation authorization; recheck before secret publication
or artifact finalization to fence concurrent stop/revocation. Capabilities have
fixed HTTPS audience/destination, no redirects, bounded schemas/rates/bytes and
no arbitrary callback URL. Diagnostics use allowlisted codes only. Account-private
readings never leak to org-visible sandbox events.

### Lifetime, rotation and revocation

For **new report/artifact grants**, propose 15-minute leases, capped by the
sandbox deadline. Renewal requires a still-valid lease and live server binding;
rotate with a maximum 60-second overlap, fenced immediately by revocation. An
expired grant cannot renew itself. Trusted launch/resume/preparation reboots
identity after a long offline interval; no owner intervention should be required
for ordinary automatic rebootstrap. Reports can remain local while disconnected.
Existing GitHub capability derivation/deadlines stay unchanged for slice 1;
shortening them to this lease scheme is a separately reviewed change, not an
assumption that the current broker already renews leases this way.

Increment a persisted revocation/generation fence **before** stop/delete,
membership removal, connection revocation or physical replacement can race a
request. Stop must reject new acquisitions/uploads while permitting only an
explicitly admitted final capture under a bounded closing-phase grant; revoke
that grant before provider stop. No renewal in closing state. This requires a
future reviewed lifecycle contract, not an exception to current active-only
checks. If final capture fails, report the failure and follow existing stop policy;
do not hang indefinitely or claim work safe.

A same-boot Boat resume also fences old grants, then privately rebinds. Modal
checkpoint seals admissions/timers/hooks, drains required durable ACK watermarks,
scrubs capabilities and issued leaves, and proves process quiescence including
helper/broker descendants under existing checkpoint rules. Never exempt a helper
writer or weaken a required terminal ACK. Restores receive fresh identity;
allowed pending reports require explicit old-to-new mapping and dedup, not replay
as new turns. Fresh forks discard source queues and identities. Golden snapshots
contain code only: scrub and verify absence of runtime grants, tokens, auth caches
and private spool/artifacts before snapshot; fail closed if uncertain. Copied
worker state is never accepted as authority, even if accidentally retained.

### Exposure and “no worse than today”

The helper must never intentionally put secrets in goldens, argv, logs, ordinary
Provider.exec payloads/results or exec journals. Bootstrap only through existing
private stdin/pinned SSH on Boat and private Runner transport on Modal. Retain
issued-leaf redaction history across broker restart; diagnostics never return
secret bytes. This is a control-transport requirement, not a confidentiality
guarantee for arbitrary guest-controlled exec output: a compromised guest can
print stolen leaves, and ordinary local Git is not an arbitrary-secret redaction
boundary. Keep account-private usage/quota collection off ordinary exec journals;
require a proven private non-journaled channel or leave those readings unavailable.
No telemetry environment dumps, paths, raw exceptions or raw native payloads.

A compromised agent can forge its own usage/liveness, upload malicious bounded
recovery data, and request allowed GitHub operations. In compatibility mode it
can also exfiltrate a GitHub user leaf and bypass wrapper repository checks until
GitHub invalidates/expires it: **the helper cannot cryptographically narrow that
user token**. This is the same underlying GitHub authority exposed by today's
static token, not a new claim of repository isolation. Repeated renewal improves
availability but extends the practical misuse window until server revocation;
cap it at sandbox deadline, rate-limit/audit issuance and never add repositories
or permissions. Thus “no worse” means no broader resources/principal/operations,
not zero incremental risk or identical stolen-token lifetime. If the owner requires
hard repository/ref attenuation or no renewable guest GitHub authority, choose
publish-by-bundle instead; do not enable this first slice on that premise.
Stop revokes Armada grants immediately, but cannot promise immediate invalidation
of a shared owner access leaf already stolen without affecting other workers.
Never grant automatic merge, force push, production deploy or general vault access.

## Installation, compatibility and upgrades

After open PR #899 lands, extend its **mechanism**, not its Skillpack binary: release-manifest exact
helper version, OS/architecture and SHA-256 verification before execution,
atomic install, bounded receipt (version/digest/protocol/capabilities), normal
worker executability on root and no-sudo images. No credentials/contact loop at
build time, no `curl | sh`, no mutable `latest`. Record receipt in the golden;
server negotiates supported protocol at launch and rejects unknown privilege
requests. Missing optional helper gives a closed unsupported/degraded reason;
a requested helper-dependent feature fails admission clearly, not mid-turn.

Default installation target is every new/rebuilt Boat and Modal golden, with
platform availability explicit. Existing goldens need config-preserving golden
update/rebuild, then fresh workers. No silent live overwrite or image mutation;
existing workers keep current behavior/manual repair until retired. Upgrade by
new pinned golden revision; retain prior pin for rollback and retire affected
workers rather than pretend disabling a gate uninstalls wrappers. Modal's reviewed
runtime overlay/checkpoint compatibility path remains separate from arbitrary
live helper replacement. Server supports a documented adjacent protocol window;
unsupported restored workers must rebootstrap or be replaced, never reuse grants.

Boat adapters preserve provider-managed Claude/Codex processes and use private
SSH only for privileged bootstrap. Modal reuses runtime drivers/journal/ACK and
checkpoint supervision. Later Docker/Kubernetes can install the same inert binary
in images and use existing process supervision/workload identity bootstrap;
Pod UID/container generation replaces provider incarnation binding. No baked
service-account token, privileged host filesystem mount or cluster-wide key.
A sidecar is optional only when its lifecycle/secret boundary is proven; portable
schemas and explicit bootstrap matter more than forcing the same process layout.

## Ordered delivery slices and staging acceptance

These are proposed follow-up issue scopes, **not implementation in #908**. Reuse
existing tickets rather than duplicating them; create new bounded tickets when
accepted. None requires waiting for another PR to merge this design. Every smoke
below is later operator-authorized staging work with disposable identities/repos,
never production access or migration application by this design author.

0. **Install the inert helper in goldens.** Depends on open, unmerged PR #899's
   provisioning mechanism. Add the helper's own exact version/digest pin and
   receipt; install no workload identity or running broker in the golden.
   Staging: config-preserving rebuild of one Boat and one Modal golden; verify
   installed binary SHA-256 against the release manifest and persisted
   version/digest/protocol receipt. Cover root-built and no-sudo images and
   execute as the normal worker user. A bad digest must never execute.
   Run the pre-snapshot scan and verify no runtime grants, tokens, auth caches
   or private spools are captured; refuse publication on scan/scrub uncertainty.
   Launch from an old golden without the helper: report a clear closed
   `unsupported` reason and rebuild action, and refuse a requested helper-only
   feature without claiming installation succeeded.
1. **Automatic GitHub refresh, no owner action per renewal.** After slice 0,
   finish the existing gated runtime (#822/#825/#830). The golden contains only
   inert helper tools/receipt, not an activated broker. On Boat keep today's
   launch-time (and authorized preparation/recovery) pinned SSH/private-stdin
   broker installation/configuration in the worker; no broker process, sockets
   or capability is baked into the golden. On Modal the broker stays inside the
   launched Runner process with private runtime bootstrap, not a second golden
   service. Keep legacy repair as explicit fallback for unupgraded workers.
   Staging: both Boat/Modal × Claude/Codex; same native PID/start time/conversation
   before and after server-cache expiry, remote read and scratch push from inside
   a turn and a second turn. Broker missing/stalled/restarted checks apply to
   **Boat only** with today's isolated broker process. Modal needs #825's missing
   staging-only Runner control to close/stall/reopen only `githubSocket` while
   retaining Journal/native processes; a Runner restart is not broker survival
   evidence. Until that control exists and passes, Modal fault coverage is
   unsupported, not passed, and general enablement remains blocked. Ordinary
   local Git survives; no token in native logs. Use the full existing runtime smoke, not
   just `gh auth status`; stop/resume denies old grants. Gate remains off until
   all evidence passes and owner accepts the exposure model. No new refresher.
2. **Boat usage/observed model (#883/#890), shared typed report lane.** Implement
   on-demand extractor plus proven hook identity, retain pull fallback; reuse Modal
   normalized accounting (#886). Staging: real nonempty native samples for both
   harnesses; requested/actual mismatch shown, duplicate/out-of-order/reset/partial
   reports do not double count, unrelated session refused, quota stays private.
3. **Preservation failure stages first (#902), then private inside-out upload.**
   First distinguish collect/encrypt/transport/storage/ACK failure. Staging: dirty
   and unpushed work recoverable through existing recovery workflow; clean reviewer
   and already-pushed/no-op cases yield no archive or preservation warning/note
   after a successful empty capture (failed inspection is not proof of no work).
   Exercise offline upload,
   size cap, denied path, repeated receipt, closing race, forced kill and
   stop/resume/stop produce honest complete/partial/unavailable outcomes. No
   auto-publication or execution of guest hooks beside server credentials.
4. **Liveness/readable failures (#887).** Add closed stage observations through
   the same report lane, no new daemon. Staging: pause helper/network independently
   of live harness, show stale rather than dead, provider terminal state wins;
   checkpoint has no orphan writers and missing required ACK still blocks.
5. **Variables/secrets (#906), then skills receipts.** Separate review defines
   assigned-key scope/revisions and private delivery; no catch-all vault route.
   Staging: cross-owner/org/key requests denied, revoked revision cannot return,
   snapshot/resume contains no stale authority. Skill pin/checksum/receipt and
   root/no-sudo execution checks reuse #899; registry outage never triggers an
   unpinned fallback. Install success is not skill-use telemetry.

Each implementation needs offline contract/security regression checks plus its
provider/harness staging evidence and sanitized revision/protocol receipts.
Installation alone is not enablement evidence. Roll back gates and retire managed
workers according to `github-runtime.md`; no automatic production enablement.

## Owner decisions still needed

| Question | Recommendation |
| --- | --- |
| Transparent Git/gh or no GitHub token in guest? | Accept existing broker only as gated compatibility slice if required now; retain publish-by-bundle as long-term safer managed target. If token exposure is unacceptable, do not enable slice 1; prioritize explicit publish instead. |
| Human or App API actor? | Preserve original owner's user actor for compatibility; offer installation identity only as explicit future opt-in, never silently substitute it. |
| Must “every golden” include already-running workers? | No: install by default at create/update; rebuild old goldens, replace workers deliberately. No live autoupdater. |
| Is continuous idle heartbeat worth another daemon? | No; provider polling plus sparse contacts and honest unknown state suffice initially. Revisit only with a measured unmet operational need. |
| Lease/retention and failed final capture policy? | Adopt 15-minute new-lane leases/60-second overlap and bounded spool as proposed; preserve existing stop and archive retention policies until separately approved. Never promise last-chance recovery after forced kill. |
| What may helper secrets delivery unlock? | Only exact launch-assigned values after #906 review. No guest-selected key enumeration, org-wide vault, or credential capability added by installing code. |

Merging this document records a recommended architecture and follow-up boundaries;
it is not permission to enable gates, deploy, apply migrations or exercise staging.
