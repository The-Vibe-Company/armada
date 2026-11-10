# ArmadaKit source contract (Swift 6)

UI imports `ArmadaKit`; hold one `ArmadaClient` actor per signed-in UI session.
`restore()`, `startEmailLogin(email:)`, `verifyEmail(email:code:)`,
`organizations()`, `selectOrganization(_:)`, `signOut()` are the initial surface.
`selectedOrgID` is actor-isolated. Calls throw cancellation or concise `ArmadaError`;
never render arbitrary response bodies or transport errors.

Production origin is `https://armada.thevibecompany.co`. `SessionStorage` permits
Keychain injection; the default is device-only Keychain, adapted from authorized
Companion `8e01b20970c36efa8779d29a1a2c02f45e20b338` SessionStore infrastructure.
No Companion business protocol, host, cookie, app identity or credentials are used.
The URLSession transport refuses redirects and uses no shared cookie/cache storage.

Email login is **code-only**. Current server requires a loopback-shaped redirect
for email/start; no listener is opened and the email link is not an app callback.
Only the code entered by the user is passed to email/verify. Native browser OAuth
needs a separate server contract; no custom scheme is invented here.

## Producer dependencies / feature gates

Auth source: `packages/cli/src/auth-commands.ts`,
`packages/mcp-server/src/control.ts` at `2d81b6db290778dbd2bffabc076b757e1c3f74e0`.
Orchestrator adapter now consumes the actual #662 owner HTTP implementation,
not only the foundation proposal. Delivered source archive SHA256:
`832312b7086e5b2db2354da70e32f1dba2331506fb24a22d33f2b80ee2e4cb30`.
The #661 DTO bytes are committed `79472bf` (merged `d748be68`);
#662 handler is qualified WIP source `f2e3ce4`, file SHA256
`33b910fa3b67560446485e64c4c561789079c0af45945c786f9bd89a7541e065`.
These source contracts are NOT deployed runtime/native conformance evidence.

Actual actor surface:
- `orchestratorCapabilities() -> OrchestratorCapabilities` (GET capabilities).
- `orchestrators(cursor:limit:) -> OrchestratorList` (GET collection).
- `orchestratorDetail(id:) -> OrchestratorDetail` (GET id).
- `orchestratorEvents(id:cursor:limit:) -> OrchestratorEventPage` (GET id/events).
- `prepareOrchestratorCreate(_:) -> PendingOrchestratorOperation` (local only).
- `prepareOrchestratorMutation(id:action:expectedRevision:text:)` (local only).
- `submitOrchestratorOperation(_ UUID) -> OrchestratorOperation`.
- `discardOrchestratorOperation(_ UUID)` removes only terminal commands or known
  pre-effect HTTP400 rejections; uncertain commands cannot be abandoned.
- `pendingOperations` restores durable pending/uncertain commands on startup.

All reads select the authorized `orgId`; cursors pass through URLQueryItem without
interpretation. Events preserve server order, stable event/message/conversation
IDs and delta/snapshot mode; native continuity is decoded, never synthesized.
Mutations persist exact bytes/key/revision BEFORE network side effects, use
`Idempotency-Key`, and have no automatic retry. The UI prepares once then retries
only the saved ID. An unresolved create blocks another create in that org; an
unresolved mutation blocks another mutation on that orchestrator. Ambiguous
errors/cancellation retain the saved command, not a fabricated failure/success.
Sign-out clears local commands with the login session.

The actual capability response is `enabled:false` with
`native_conformance_required`; mutations refuse to send while disabled. A missing
route is an HTTP error, never permission to fall back to ordinary allocation.
No settings/wait mutations or private delegated/native RPC routes are exposed:
those public routes are unwired in the delivered snapshot.

Size contract update: actual #662 commit
`b6ca6e184fb28ec51ede5151505fda68f599954c`, verified all five source hashes in
SIZE-CONTRACT.json. `OrchestratorCreate.size: MachineSize?` and its initializer's
optional `size:` accept only `small`, `medium`, `large`, `xlarge`. nil omits the
field (never a "default" sentinel); an omitted repository also stays omitted.
The actual producer validates, digests, persists and maps these public selectors
to the real launcher. Server policy remains override > explicitly selected repo >
golden > legacy. The client does not copy resolver math, invent backend defaults,
or fall back to another allocator. This is bounded source proof, not backend
review/full-runtime proof. Operator native proof and deployment remain external
prerequisites, not implied by client tests.

## Mac validation checkpoint

From repository root: `swift test --package-path apps/ios/ArmadaKit`.
Package targets iOS 17+ / macOS 14+, Swift tools 6.0, no external dependencies.
Linux sandboxes without Swift or the Apple Security/CryptoKit SDK cannot execute
this package. The Apple Quality workflow runs these actual package tests and
`apps/ios/scripts/verify.sh` compiles both generated app variants for the iOS
simulator on macOS. It does not boot a simulator, exercise rendered interactions,
sign or deploy the application.

## Sandbox metadata source

`SandboxMetadata`, `SandboxMetadataPage`, `sandboxMetadata(page:limit:)` consume
#680 source `986a5270d8e4ed31cf7fff16ddca43570d838a6b`: core sandbox-access.ts,
MCP tools list envelope, control sandbox/list POST handler. This method requires
the coupled #680 deployment; old servers do not provide the same safe DTO.
It never calls interior routes and does not infer authority from display IDs.

## Recovery and retention

Initial structured HTTP400 `invalid_request` is a definitive validation refusal
and can be discarded. Generic409 remains uncertain: exact body/key/CAS survive
reconnect, and no replacement command is automatically allocated.

`reconcileOrchestratorOperation` uses existing owner detail operations when an
exact receipt ID is known (matching ID, parent, action, revision and organization).
It never POSTs. Missing/mismatched receipts and failed reads do not prove rejection.
A lost response without a receipt ID cannot safely be matched by action/revision.
The user can explicitly forget uncertain tracking after a warning via
`discardUncertainOrchestratorOperation(_:acknowledgingPossibleEffects:)`.
This does not cancel server work, prove non-admission or automatically resend;
a new command may duplicate effects. The app offers confirmation on create,
lifecycle and message recovery. Active submissions cannot be discarded.

Durable storage retains at most 32 terminal commands, including on restore;
unresolved commands are never automatically evicted. Concurrent submitters retain
terminal receipt knowledge in memory only until their last caller exits, so
pruning cannot turn a known outcome back into an unknown one.

Unknown outer/nested event kinds retain JSON in the SDK without aborting the
page or losing its opaque cursor. The app skips these variants rather than
rendering arbitrary payloads as assistant text. Known malformed variants still
fail decoding. No conversation or native continuity is synthesized.

Follow-up producer improvement: authoritative exact-key admission/receipt
correlation would permit safe automatic recovery of pre-admission CAS conflicts.
It is not required for the explicit warned local-abandon workflow and no endpoint
or discriminator is invented here.

## Sandbox interior (#711)

`sandboxDetail(id:)`, `sandboxEvents(id:cursor:)`, `sendSandboxPrompt(id:text:)`
and `stopSandbox(id:)` call the routes the CLI already uses (`sandbox/detail`,
`logs/read`, `sandbox/send`, `sandbox/stop`, all `POST /api/v1/…` with the
selected `org`). No server route was added. The interior is owner or current
admin only (#680, `docs/contracts/sandbox-access-v1.md`); list `canOpen` is a
hint and every call is reauthorized, its 403/404 reported as no access.
`SandboxDetail.admission`/`canStop` are the pure composer and stop rules.

`sandbox/send` has no idempotency key: a prompt is sent once and never retried
by the client. `SandboxMutationFailure.classify` makes 400/409 a definite
refusal and every other failure unconfirmed; the app then shows the prompt as
not confirmed and lets the transcript show whether it arrived. Stop is safe to
repeat. Unknown `other` events without `data` keep their page and cursor.

## Opening a conversation fast (#813)

`ConversationLoader` is the loading order both conversation screens use, over
any event type and fetch, against the #812 paging contract (`logs/read` and the
orchestrator events route with `direction: backward`):

1. a `ConversationCache` snapshot from earlier in the session is shown before
   any request;
2. otherwise the latest page is read backward from the end and shown, so the
   first paint is one read and shows the newest messages;
3. the stream is followed forward from that page's `cursor` (the live
   frontier), back to back while the server reports more, otherwise after the
   poll delay;
4. older pages are read only when asked (`loadOlder`, on scroll-up) from
   `olderCursor` and prepended. They never move the frontier, and an event
   already shown is replaced in place, so history and live follow stitch
   without gap or duplicate.

Reads are not coalesced: #812 coalesces a page's fragments into a snapshot of
that page's text only, which would replace the earlier part of a message that
spans pages. A page whose single event exceeds the default 256 KiB budget is
refused (400); the app reads it again once with `largestEventPageBytes`. A
`logs/read` server without backward reads answers with its first page and no
`olderCursor`; it is then followed forward at once. The orchestrator events
route of such a server refuses `direction`, so the app needs a server with #812. The clock is injected; tests
use a recording one.

## Launching a sandbox (#750)

`launchCatalog()` reads `launch/options` (the server's harness, model, effort,
credential-kind, machine-size and TTL catalogs, added for this app), `golden/list`
and `creds/list` for the selected `org`. `SandboxLaunchCatalog` derives what the form
offers: goldens of that org (ready first), models and efforts per harness, the account
the server would resolve (user default, only user account, org default, only org
account; several without a default is `ambiguous` and the person chooses), repository
and size choices, and TTL presets within the golden's provider limit. Nothing is
hardcoded: an unknown harness or model is offered with its raw id.
`SandboxLaunchDraft.request(catalog:)` mirrors the server's checks and builds the body of
`sandbox/launch-sized-v1` (`sizePolicyVersion: 1`, the route `armada launch --sized` and
the dashboard use); omitted optionals keep the server defaults.

`launchSandbox(_:)` has no idempotency key: it is sent once with a ten-minute timeout and
never retried. `SandboxLaunchFailure.classify` maps pre-start codes to `refused` (the
form keeps every field), `start_failed`/`init_failed`/`prompt_failed` to
`failedAfterStart` (a failed sandbox may be listed), a provider's non-allocating fork
refusals (503 `unauthorized`, `payment_required`, `provider_not_configured`,
`not_found`) to `refused`, a failure before the request leaves the device (offline,
session refresh) to `notSent`, `credential_refused` (422) to `refused`,
and `provider_unavailable` (502), `dependency_unavailable` (503),
lost answers, `outcome_unknown`, other 5xx and unknown codes to `unconfirmed`
(check the list before launching again). Each code selects
local text adapted from the dashboard's failure help; only validation codes add the
server's own message, on one line of at most 300 characters. Sandbox delete is not
offered: `/api/v1` has no delete route for a sandbox.

## Orchestrators on the phone (#751)

Create sources are the New sandbox form's reads for the selected organization
(#750, #815): `launchGoldens()` (`POST golden/list`, `LaunchGolden`) and
`launchAccounts()` (`POST creds/list`, `LaunchAccount`; ids, names and kinds
only). Provider and harness ids are open values (`ArmadaProvider`,
`ArmadaHarness`), never a closed list in the app.

`OrchestratorCapabilities` decodes the server's `pairs` (provider × harness,
`enabled`, `reason`, `continuity`) and `harnesses` (suggested models and efforts,
the credential kinds that run each harness), additive to the capabilities route
since #751. `OrchestratorCreateCatalog` offers only ready goldens, enabled pairs
with their continuity in plain words ("Resume guaranteed" for `native`, "Resume
not guaranteed" for `best_effort`; a disabled pair keeps its reason as a
sentence), the server's models and the usable (active, unexpired) accounts whose
kind runs the harness, the person's before the org's. The account is preselected
as the server resolves it and chosen only when there are several; it validates a
`Draft` into the exact `OrchestratorCreate`.

`followOrchestratorCreate(_ UUID, sleep:)` follows an accepted create: it reads
the new orchestrator's detail on `OrchestratorPolling`'s schedule (backing off
after a failed read), records the create receipt, sends nothing, and returns
`OrchestratorCreateProgress` `.ready` or `.failed`. `sleep` is the injected clock.

`OrchestratorControls` derives what may be done from state, continuity and open
operations (the dashboard's rule): nothing new while any operation is open;
message only when ready; steer only while a turn runs; stop when ready or blocked;
resume only a stopped native conversation; recover only what the server can
settle at the current revision (an open or pre-machine-failed create, an uncertain
stop) or an uncertain first create. `OrchestratorCreateProgress` says when a create has
settled: nothing is sent before. `OrchestratorPolling` gives the next detail or
list read (transitional states and open operations only; failures back off to a
minute). `OrchestratorExplanation` turns request codes, receipt `errorCode`s,
`blockedReason`s and pair reasons into sentences; an unknown code still reads as
one. `recover` is a durable mutation like the others (same key and revision on
retry); its receipt is the `stop` (or `create`) it settles.
