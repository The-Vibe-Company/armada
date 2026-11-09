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
Orchestrator foundation at that ref explicitly calls itself **proposed** and has
no mounted handlers. #662 has been asked for hash-bound actual runtime routes.
Native orchestrator continuity remains OFF pending real operator conformance.
No resume-by-prompt, guessed endpoint, account credential or direct Supabase call
is permitted. Size must not be added to the proposed create DTO until published.

## Mac validation checkpoint

From repository root: `swift test --package-path apps/ios/ArmadaKit`.
Package targets iOS 17+ / macOS 14+, Swift tools 6.0, no external dependencies.
Linux sandbox has no Swift toolchain or Apple Security/CryptoKit SDK: tests/build
are **not yet validated**. Mac integration must compile and run these actual
sources before accepting this package. This is infrastructure, not rendered UI;
there is no app target or simulator screenshot in this ticket.
