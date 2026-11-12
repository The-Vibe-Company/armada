# Native subscription authentication and renewal (#604)

## Scope and prerequisites

#604 owns local native consent/import, private refresh-state transport, exclusive
ownership, encrypted auth revisions, hydration and redaction. Per-account quota
telemetry is separately owned by #624. Native credential redaction of provider
events and nested tool output belongs to #604.

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
      "nativeSubscriptionParallelSandboxes": false,
      "nativeSubscriptionResume": true,
      "nativeSubscriptionExec": true
    }

The example above describes legacy native ownership. Configured server-owned
renewal deployments advertise `nativeSubscriptionParallelSandboxes: true`; see
the shared-session section below.

The nativeCLI map contains base commands only, without --name placeholders.
#618 appends its one shell-quoted account name. It offers terminal consent for
personal accounts only; CLI org import/login explicitly accepts --org under
fresh admin authorization. There is no Claude terminal-login entry: paste/private
import is supported, not a fake hosted Connect button.

## Legacy private native state lifecycle

- One refresh-bearing account binding has one durable sandbox owner, claimed
  before provider allocation/hydration. Scheduling expiry never reassigns a live
  refresh token. Additional owners fail explicitly with credential_busy.
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

No inference translation, cross-provider proxy, automatic account switching or
central third-party OAuth client is implemented. A registered Sign in with
ChatGPT self-hosted-VM integration needs approved eligibility and must preserve
the VM's host identity. Native personal CLI use is not central-hosting eligibility.

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


## Pre-renewal rollout workspaces

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
are stopped before enrollment. An unrecorded/ambiguous old allocation remains
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
