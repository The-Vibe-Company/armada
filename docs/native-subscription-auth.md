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

The nativeCLI map contains base commands only, without --name placeholders.
#618 appends its one shell-quoted account name. It offers terminal consent for
personal accounts only; CLI org import/login explicitly accepts --org under
fresh admin authorization. There is no Claude terminal-login entry: paste/private
import is supported, not a fake hosted Connect button.

## Private native state lifecycle

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

### Failed launches (#1176, slice 1)

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
