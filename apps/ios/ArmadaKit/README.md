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
