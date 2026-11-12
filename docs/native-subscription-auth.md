# Native subscription authentication and renewal (#604)

## Current owner policy (#1176, 2026-11-12)

Subscription accounts are reusable like API keys, with no Armada exclusivity,
use-history lease, holder or reconcile/release step. #1248 owns lock removal.
Legacy behavior documented below describes compatibility code, not a requirement
to retain those restrictions or impose a fleet-migration gate. The owner allows
only the already-open PRs and their stack to finish; further feature work is cancelled.

## Scope and prerequisites

Configured servers use shared, server-owned Codex sessions (#1176): launch
admission goes directly to the subscription broker, not the exclusive legacy
owner. See [Shared server-owned Codex sessions](#shared-server-owned-codex-sessions-1176).
API keys and model-only Claude setup tokens do not use rotating-session ownership.

Local native consent/import, encrypted auth revisions, hydration and redaction
remain supported. Legacy ownership and private native-state transport are retained
for historical refresh-bearing homes, explicit legacy binding/recovery and
compatibility embedders without a broker. Their removal follows #1248 and the
owner policy above; this PR adds no further migration requirement. Per-account
quota telemetry is separately owned by #624.

Requires #603's named account IDs, binding versions and sandbox pins. Apply
20261110120200_named_model_credentials.sql, then
20261110120300_model_auth_usage.sql, before enabling this server version.
Only the integration owner merges, applies production migrations or deploys.

## Supported local consent and import

    armada creds login codex --name "Personal ChatGPT"
    armada creds import codex --name "Existing ChatGPT" --file "$HOME/.codex/auth.json"
    armada creds import claude --name "Personal Claude" --file /private/path/claude-token

Codex login invokes the installed official native app-server device flow in a
private temporary home. Only its validated verification URL/device code reach
the terminal. Five-minute expiry, Ctrl-C and SIGTERM cancel it; its entire owned
process group and private home are cleaned up. Credentials travel only to the
authenticated named-account control API. Neither native stdout nor raw errors
are forwarded. Supported local platforms are Linux and macOS.

Claude users obtain a model-only token with the official claude setup-token
flow, then import it from a private file or piped stdin. Never put tokens in
arguments, shell history, chat or logs. This token cannot query profile allowance.

Replacement uses --id <account-id> --expected-version <current-version>.
The server freshly authorizes the owner/admin and seals the value; stale explicit
replacements fail. Local consent cannot override server authorization.

## Terminal capability contract for #618

Authenticated POST /api/v1/creds/accounts/auth-capabilities returns, additively:

    {
      "hostedOAuth": false,
      "nativeCLI": {"codex_auth": "armada creds login codex"},
      "nativeSubscriptionParallelSandboxes": true,
      "nativeSubscriptionResume": true,
      "nativeSubscriptionExec": true
    }

The example describes configured server-owned renewal. Compatibility embedders
without a subscription broker advertise `nativeSubscriptionParallelSandboxes:
false`; that legacy mode is not the shared-launch path.

The nativeCLI map contains base commands only, without --name placeholders.
#618 appends its one shell-quoted account name. It offers terminal consent for
personal accounts only; CLI org import/login explicitly accepts --org under
fresh admin authorization. There is no Claude terminal-login entry: paste/private
import is supported, not a fake hosted Connect button.

## Legacy private native state lifecycle

- A legacy refresh-bearing home retains its durable sandbox owner. Explicit
  legacy binding claims that owner before native hydration; this is not the
  configured shared-session launch admission. Compatibility embedders without a
  broker also retain this legacy admission. Scheduling expiry never reassigns a
  live legacy refresh token. Additional legacy owners fail with credential_busy.
  API keys and model-only Claude tokens do not enter this gate; distinct named
  renewable accounts remain independent and can run in parallel. Managed Modal
  native conversations serialize through publication, not just native child exit.
  Managed Boat app-server bridges use a private OS flock retained by the native
  group even if the bridge crashes. Boot/start identity plus the inherited lock
  descriptor authorize private orphan-group cleanup. Pre-stop admission
  pauses new writers, closes the isolated native process group, and requires
  private capture under that same lock before the stop can continue. A sync
  failure preserves compute/auth; normal shell exec remains available. The next
  authorized prompt reopens admission after reconciling retained disk state.
- The model_auth_state table uses canonical AES-256-GCM encryptSecret/decryptSecret
  with ARMADA_ENCRYPTION_KEY. An independent auth_revision CAS tracks native
  rotation; routine refresh never mutates the explicit replacement version.
- Both providers support pinned SSH. sshPrivateAuthState captures at most 64 KiB
  from a fixed native auth path, validates private regular files, and discards
  stderr. It never uses Provider.exec, command journals or a public DTO.
- Modal publishes over its private generation-bound ingest channel before
  state.checkpoint can remove native auth. Publication requires the current
  App/workspace/environment, generation, membership and exact account pin.
  An unknown/failed ACK prevents checkpoint completion and leaves auth intact.
  Hydration uses the latest sealed state of that same account/version/owner.
  Before same-generation crash recovery, detached native children using the exact
  managed home are quiesced and surviving state is published before destructive
  restore. A failed boot-time ACK leaves that source intact. A checkpoint-only,
  generation-scoped durable receipt permits retry after auth scrubbing; ordinary
  turn publication cannot satisfy a missing checkpoint source.
- Known explicit replacement/revocation can acknowledge discard, without
  publishing or reviving the old credential, so stopping old compute preserves
  sanitized conversation history.
- Boat pre-prompt, post-turn observation, pre-stop and pre-snapshot hooks capture
  current native state privately. Stopped compute is not resumed just to read it.
  Same-owner Boat resume retains native disk state, then captures it again.
- Auth leaves are registered before public exec, at command close before result
  persistence, and after Codex RPC output before event emission. Server exec
  redaction also samples private state before/after commands. Retired state is
  usable only for redaction, never for auth hydration. Boat's provider event
  boundary filters nested messages/tool results, including retained old tokens
  after explicit replacement and stop; it does not resume stopped compute.
  Archived output requires a durable quiesced-capture purpose, not an old live
  sample. Managed exec shares stop's lifecycle admission and invalidates the old
  receipt before a command can auto-resume/mutate auth; it samples again before
  releasing output. Unknown auto-archive races return a retryable state-sync
  error, rather than forwarding unsynchronized bytes. Shell inspection itself
  remains admitted for running workspaces, including retired bindings; model
  billing remains fenced. A stopped retired Modal workspace still requires
  explicit binding recovery before restore; it is never seeded from a new default.
  Boat's managed bridge also samples/registers current and superseded token
  leaves before native RPC forwarding and filters output before provider journals.
- Confirmed pre-allocation refusals release their unexposed initial lease.
  Ambiguous outcomes retain ownership. An explicit new credential version can
  transfer ownership only after the former native writer is stopped.
- Unknown legacy bindings are not silently assigned a current default. Explicit
  owner-binding recovery belongs to #603; native history is retained.

Shared mode replaces this legacy renewal path with server-owned refresh and
native external-token RPC. It does not introduce a model-inference proxy.

## Evidence and sources

Tests use synthetic native peers, real process/IPC boundaries and real migrations.
No real provider consent, production deployment or production migration was
performed by this implementation.

Pinned runtime: Claude SDK 0.3.322 / Claude Code 2.1.322; Codex 0.167.0.

- [Claude authentication](https://code.claude.com/docs/en/authentication)
- [Claude hosted-use conditions](https://code.claude.com/docs/en/legal-and-compliance)
- [Codex native auth](https://learn.chatgpt.com/docs/auth)
- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [Self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)
- MIT reference [yetone/magpie, 195d79939e215828c8b1cca73650b1d5c5cb8318](https://github.com/yetone/magpie/tree/195d79939e215828c8b1cca73650b1d5c5cb8318),
  internal/provider/logins.go: consulted, no source copied.


## Legacy pre-renewal rollout workspaces

A Codex workspace without an explicit account binding, or a pinned subscription
workspace created before native renewal enrollment, has no trustworthy durable registry for tokens it may already have rotated.
Public logs/exec output and native bootstrap fail closed rather than returning
unregistered secrets or reusing the original refresh token. Stopping that writer
remains available. After confirming it is stopped, explicitly import a fresh
account version and launch a new sandbox; old archived output stays unavailable.
The server never silently adopts that home. Explicit recovery of an **unbound,
stopped** Modal workspace enrolls a fresh selected native account atomically with
both account pins; it cannot steal an account already owned by another sandbox.

Native admission also refuses a copied refresh session under a second named
account. For an upstream account with historical workspace bindings, stop the
old writer and explicitly replace/version that **same** account row rather than
importing a second name to bypass its ownership. Independent upstream accounts
remain parallel. Identity admission is serialized and bounded; an oversized
registry fails closed for maintenance instead of skipping checks.

### Failed launches (#1176, slice 1)

#### Owner-approved delivery boundary

The owner requested one small PR per slice, starting with immediate unblock and
then concurrency, with **Refs #1176** rather than closing the whole issue. This
is the delivery contract, not a claim that slice 1 completes the full ticket.

| Work | Delivery | Acceptance status |
| --- | --- | --- |
| Failed-launch cleanup and existing trapped-account product recovery | PR #1180, slice 1 | Implemented; local SQL, launch and browser checks pass; deployed provider checks below remain unperformed here. |
| Concurrent subscriptions and server-owned refresh | PR #1186, slice 2 | Separate implementation; requires matching runtime and combined deployed acceptance, not established by this PR. |
| Explicit account re-pointing and missing-pin default fallback | Slice 3 | Outstanding; releasing/deleting a holder is **not** re-pointing an existing sandbox. |
| Obsolete legacy machinery cleanup | Slice 4 | Separate from the immediate-unblock change. |
| Vendor plan-limit/reset presentation | Issue-level runtime/provider requirement | Not addressed or claimed delivered by this failed-launch recovery PR. |

The exclusive gate must remain on the legacy native-auth path until the shared
refresh implementation replaces that path; removing only the gate would allow
multiple guests to rotate one refresh token. Do not mark full issue acceptance
complete from this PR's recovery tests. The production Work recovery procedure
and the required real-provider checks are documented below.


Before the first prompt is dispatched, initialization failures mark the managed
Codex account as never started. Armada deletes that failed physical sandbox and
releases its account only after deletion is confirmed. A failed deletion retains
the claim: on the account row, use **Find subscription holder**, then **Release
subscription** to retry deletion and release. Only the sandbox owner can inspect
this holder; organization accounts additionally require an admin for release.
The API equivalents are `POST creds/accounts/holder` (`id`, `version`, `org`) and
`POST creds/accounts/release` (also `sandboxId`). Neither returns auth material.
Older ambiguous or unclassified history requires the explicit reconnect/recovery
flow below; empty conversation history alone is not a safety proof. Concurrent
subscription refresh is a separate slice; this change does not enable parallel
rotating-token writers.


### Recover an existing trapped account through the product

The investigation on #1176 identified permanent same-version sandbox history,
failed/deleted holders, and ownership pointing at an unrecorded launch. Stopping
a failed sandbox alone does not repair the account's ownership.

For an existing account such as **Work**, use **Models → Work → Find subscription
holder**. The lookup shows the stored holder even if the account has since been
replaced. An unrecorded launch is identified without linking to a nonexistent
sandbox page.

1. Stop any recorded running holder through its sandbox page and wait for its
   current operation to finish. Never release an active native writer.
2. If requested, use **Reconnect subscription** to replace the account with a
   fresh auth.json obtained through the official native sign-in. Replace the
   **same account**, not a second name. Do not paste credentials into chat or a
   command argument. Replacement invalidates the old account revision.
3. Find the holder again, then choose **Release subscription**. For recorded
   failed, stopped or deleted history, Armada confirms physical deletion (an
   authoritative provider not-found is sufficient) before releasing ownership.
   Pending or unavailable deletion retains the claim. Unrecorded old allocations
   require explicit replacement first, fencing their old-version bootstrap.
4. Launch again. If another historical binding is reported, stop/recover that
   binding too; live history is never silently discarded.

Newly classified never-started failures retain their automatic cleanup and do
not require reconnection. Older ambiguous or unrecorded failures are never
classified as safe merely because their conversation list is empty. Recovery
requires the account owner, and an organization account additionally requires an
administrator. No database edits or deployment-time data repair are needed.

For pre-enrollment history with no credential version, **Reconnect and release**
combines the fresh auth.json import and confirmed holder deletion in one guarded
request. Armada never invents a historical revision or treats a rename as a
reconnection; a pending/failed deletion leaves the current credential unchanged.

### Required deployed coordinator checks (not performed by this PR author)

Local evidence is synthetic-provider SQL/transport coverage and Chromium product
flows, not evidence of real Boat/Modal deletion. No real provider, staging
subscription, or production recovery was exercised here. The coordinator must
record the deployed commit, provider, logical/physical sandbox IDs, account
revision, observations and outcomes below, without credentials or auth payloads.
Use disposable staging resources and a staging-only account, never production
keys or the production **Work** account for fault injection.

Run this lifecycle matrix separately on **Boat and Modal**:

1. **Pre-dispatch failure:** arrange a disposable golden's launch initialization
   to fail after allocation but before any native prompt. Verify the original
   failure is retained, observe deletion/authoritative absence using that
   provider's control plane, then launch again with the same account. Successful
   next admission, not just an empty ownership row, is the pass condition.
2. **Deletion pending/unavailable:** use a staging-only fault proxy or test
   deployment to delay/refuse the provider deletion/termination operation while
   allowing allocation and initialization. Trigger the same failure. Verify
   ownership remains, the holder is discoverable and another launch is refused.
   Restore deletion access and retry **Release subscription**. Boat's asynchronous
   deletion receipt alone must not release ownership; require a confirmed deleted
   result or authoritative not-found. Modal must confirm termination/deletion,
   including its retained recovery artifacts. Retry launch only after that proof.
3. **Existing trapped history:** reproduce a failed/deleted holder and an
   unrecorded allocation using the pre-fix staging build or a controlled staging
   fixture, then deploy the candidate. Recover through the product procedure
   above and verify a subsequent launch works. For unrecorded allocations, do
   not report physical deletion: no physical ID is known. Explicit fresh account
   replacement fences the old version; verify a delayed old launch cannot pass
   bootstrap/prompt admission after replacement. Unversioned recorded history
   requires the combined import-and-release action and physical deletion proof.
4. **Admission race:** overlap a later send/resume with initial-failure cleanup.
   Admitted work must not be deleted or stopped by stale cleanup. A later
   ambiguous dispatch must permanently invalidate the original never-started
   proof, even after its activity lease ends. Verify pending/failed recovery
   leaves the current credential unchanged and never returns auth material.

**Separate slice-2 acceptance (PR #1186):** after deploying the server-owned
refresh implementation and matching native runtime, run three Codex sandboxes
on one ChatGPT account concurrently on each provider. While all three remain
alive, exercise an actual access-token refresh through the server broker and
verify all three answer follow-up prompts. Record the server auth revision and
successful prompt IDs, never token values. Also verify three concurrent Claude
model-only setup-token sandboxes on each provider; those tokens do not carry a
shared rotating refresh token. These are required deployed checks, not results
established by this slice-1 PR. Explicit account re-pointing/default fallback is
slice 3; neither it nor full issue acceptance is claimed complete here.

## Shared server-owned Codex sessions (#1176)

New subscription enrollment on the configured server uses external-token Codex
app-server authentication. One account can serve multiple Boat and Modal
sandboxes. The refresh token stays encrypted on the server; sandbox bootstrap
contains a private, sandbox-and-account-pinned access capability, not auth.json
or `ARMADA_CODEX_AUTH_JSON`. Native app-server receives only an access token and
account identity, and asks Armada for renewal through its private
`account/chatgptAuthTokens/refresh` RPC.

The server commits renewal intent before contacting the upstream, then publishes
sealed replacement tokens with an auth-revision compare-and-swap. Concurrent
requests reuse the replacement revision, including across server replicas. A
lost upstream response cannot safely be retried with the old rotating token:
renewal remains uncertain and the owner must reconnect/import a fresh account
revision. Failed allocations do not exclusively reserve server-owned accounts.

Legacy refresh-bearing native homes keep their existing fences. To move an
existing account into shared mode, stop its old sandboxes and import a fresh
revision of the **same account**. Armada verifies historical physical writers
are stopped or authoritatively absent before enrollment. Unavailable/uncertain
observations are not absence proof. An unrecorded/ambiguous old allocation remains
blocked until the authorized product recovery described below is completed.
Copying the old auth file under another name is not a
migration; duplicate sessions and same-owner historical identities are refused.
Model-only Claude setup-token accounts already allow concurrent sandboxes and do
not participate in rotating-session ownership.

Both the portable Modal runner and Boat's native stdio bridge must contain the
external-token integration. Build the runtime with
`bun scripts/prepare-runtime.ts` (CI builds the native artifact). Boat installs
the current bridge at shared-auth hydration; it fails the launch if installation
or private configuration fails. Do not enable a server-only admission change
with an older runner distribution. Existing API-key launches are unchanged.

The private access endpoint checks the current sandbox pin, logical lifetime,
credential version/status and owner membership before returning material. Its
capability is stable for the logical sandbox/account binding, so all such grants
can be reconstructed for redaction; expiry and revocation are authoritative in
SQL, not guest claims. Capabilities and current/superseded access tokens are
redacted before public output. No upstream body or refresh failure detail is
logged or returned.

Later hardening: physical-incarnation-specific access capabilities, per-grant
revocation independent of account/sandbox revocation, bounded historical token
registry compaction, and richer reconnect diagnostics. Staging acceptance still
requires three live sandboxes to answer concurrently through an actual refresh;
unit/transport tests use synthetic vendor material only.


### Native plan-limit failures

A native subscription limit is a failed prompt, not a failed launch or an
expired login. Codex terminal usage/rate-limit codes are preserved with a fixed,
actionable public message. When the vendor supplies a valid reset for an
applicable exhausted window, the message and structured result retain that reset time; no
reset is invented from missing, malformed or non-exhausted quota data. If more
than one exhausted window supplies a reset, report the latest blocking reset.

Both Boat and Modal feed the same safe public outcome contract. Raw vendor
error text, credit balances, plan/profile details and the rest of the private
quota payload remain private; only allowlisted failure classification and reset
metadata are promoted. Authentication failures keep their separate identity.

### Recover legacy ownership before shared enrollment

For existing trapped accounts, this slice-2 server must be deployed together
with the slice-1 product recovery in [PR #1180](https://github.com/The-Vibe-Company/armada/pull/1180).
This PR alone does not expose that recovery action. Do not remove the orphan
ownership guard or delete ownership rows manually to bypass it: no recorded
sandbox means this broker cannot establish physical quiescence of that holder.

After both slices are deployed:

1. Open **Models → the same account → Find subscription holder**. The slice-1
   lookup exposes the stored holder even after the credential revision changes;
   it also distinguishes unrecorded and unversioned history.
2. Stop any recorded live holder and finish its current operation. Use
   **Reconnect subscription** with a fresh official native auth.json when
   requested, then find the holder again and **Release subscription**. Recorded
   holders require authoritative physical deletion/absence before release.
   Unversioned recorded history instead uses the atomic **Reconnect and release**
   action; a pending/failed deletion must leave the credential unchanged.
3. For an unrecorded allocation, do not claim that a physical sandbox was
   deleted: its physical ID is unknown. Explicit replacement of the same account
   is required first. The recovery transaction fences the old credential version
   before retiring its orphan claim, so a delayed old-version launch cannot pass
   bootstrap/prompt admission. Old sealed native state is retained; importing the same
   session under a second name is not the recovery procedure.
4. Retry launch. Shared enrollment can now initialize the fresh account revision
   without an exclusive ownership row. If another historical binding is reported,
   recover it through the same product path; never silently erase live history.

**Required coordinator staging check, not performed here:** on both Boat and
Modal, reproduce an old unrecorded claim using the baseline build or a controlled
staging fixture. Deploy both slices, complete the product recovery above without
SQL repair, verify delayed old-version admission is refused, then launch three
same-account sandboxes concurrently through an actual server token refresh.
Record deployed commits, safe account revisions and successful prompt IDs, never
auth payloads. The [slice-1 deployed lifecycle checklist](https://github.com/The-Vibe-Company/armada/blob/bf81c6783530aeaacada7e6a0daa121851ab5f1a/docs/native-subscription-auth.md#required-deployed-coordinator-checks-not-performed-by-this-pr-author)
additionally covers deletion pending/unavailable, confirmed absence and account
reuse. No real provider, staging or production acceptance is claimed by local
synthetic-provider tests.

Explicit sandbox account re-pointing and missing-pin default fallback remain
slice 3 of #1176. They are not implemented by this concurrency slice, and the
removed-API-key acceptance criterion remains open until that slice is delivered.
