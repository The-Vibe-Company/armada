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

`ConversationLoader` loads sandbox conversations over any event type and fetch,
against the #812 paging contract (`logs/read` with `direction: backward`):

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
`olderCursor`; it is then followed forward at once. The clock is injected; tests
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
a 4xx whose code this build does not know but which carries the server's message to
`refused` (#962), and `provider_unavailable` (502), `dependency_unavailable` (503),
lost answers, `outcome_unknown` (on any status), other 5xx and an unknown code without a
message to `unconfirmed` (check the list before launching again). Each code selects
local text adapted from the dashboard's failure help; validation codes and codes without
local text add the server's own message, on one line of at most 300 characters. Sandbox delete is not
offered: `/api/v1` has no delete route for a sandbox.

## Upgrade compatibility

Stored sessions remain origin-bound and preserve their selected organization. Older
builds may have stored an orchestrator command journal beside the session; those
unknown fields are ignored and are not replayed by this build. Removing the local
client does not stop or delete any server-side compute. The server must retain old
app compatibility until this build has been published and the coordinator approves
its later removal.

## Values the server adds later

Sandbox statuses, providers, harnesses and event variants retain unknown wire values.
The server-generated cross-language fixture includes old-client contract data; this
client tests only its sandbox responses. Unknown agent event kinds keep the page and
cursor and are counted as technical events, never rendered as assistant text.
