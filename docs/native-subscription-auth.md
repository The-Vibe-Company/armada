# Native subscription authentication

## Shared accounts (#1248)

Subscription accounts work like API keys: any number of sandboxes can use the
same account simultaneously. A failed, deleted, stopped or unregistered earlier
sandbox does not reserve an account. There is no holder, release or reconcile
step before launching or prompting.

New Codex launches use the server-owned renewal broker from #1186 and receive an
access-only capability; rotating refresh tokens stay sealed on the server.
Refresh intent and revision compare-and-swap coalesce concurrent renewals across
server replicas. A lost upstream refresh response remains an authentication
uncertainty, not an exclusive sandbox reservation; reconnecting imports fresh
login material if the upstream session is no longer valid.

Claude model-only setup-token accounts can also serve multiple sandboxes. API
key delivery is unchanged. Account ownership/membership, current credential
version/status and sandbox pins remain authorized on each private access request.
Secrets are encrypted at rest, never logged or returned by public APIs, and
redacted from public events and command output.

## Connect an account

```sh
armada creds login codex --name "Personal ChatGPT"
armada creds import codex --name "Existing ChatGPT" --file "$HOME/.codex/auth.json"
armada creds import claude --name "Personal Claude" --file /private/path/claude-token
```

Use the official local Codex device flow or Claude `setup-token`. Never put
credentials in arguments, shell history, chat or logs. Replacement uses
`--id ACCOUNT_UUID --expected-version REVISION`; explicit replacement changes the
account version, unlike an ordinary broker refresh.

## Deployment and coordinator acceptance

Deploy the matching server and native runtime from #1186 together. Build with
`bun scripts/prepare-runtime.ts` (CI builds the native artifact). Boat installs
the current access-only bridge at hydration; Modal uses the private runner.
Do not deploy an admission-only server change with an older runner.
No new migration is required by #1248; existing authentication tables remain
sealed storage, not an exclusive admission registry.

After deploy, launch directly on the owner's existing subscription account,
without reconnecting, releasing or reconciling first. On both Boat and Modal,
launch three Codex sandboxes on that account and send prompts concurrently,
then verify follow-up prompts through a real server-owned token refresh. Also
check three concurrent Claude setup-token sandboxes. Record prompt IDs and
success, never tokens. Failed/deleted/unregistered historical allocations must
not block admission. These are coordinator-run deployed checks, not claimed
local results.

A native plan limit remains a prompt failure, not a launch failure or expired
login. Only applicable vendor reset evidence is surfaced; raw vendor errors
and private quota/profile payloads remain private.

## Automatic transition of existing native writers

Before first adoption, the server upgrades observable live writers automatically.
Boat's tracked native writer is quiesced, its latest private auth is captured,
and the access-only bridge replaces its refresh-bearing file and managed marker.
Modal checkpoints its old runner before adoption; its next normal resume starts
with access-only configuration and removes restored raw auth after retaining
redaction leaves. A legacy native turn may be interrupted once during upgrade;
workspace and conversation data remain retained. No user stop, release, re-import
or reconcile action is required by historical bindings.

A known Boat home discovered after account adoption is also converted before its
next prompt. Captured auth is not blindly promoted over broker state: the server
validates it through a coordinated upstream refresh and publishes the verified
replacement with revision CAS. An authoritatively rejected stale guest token may
fall back once to a separately held current token, never replaying an uncertain
token. Normal renewal can invoke the same automatic recovery. Confirmed temporary
upstream failures keep the private candidate paused for an ordinary retry, not a
forced sign-in.

Terminal, absent and unobservable historical allocations are ignored rather than
becoming admission fences. Old/unknown pins are not silently re-pointed. If a
rotating upstream accepts a refresh but its response is lost, the replacement
secret may be absent from every trusted source. The server cannot reconstruct an
opaque replacement or safely replay the spent token. After trying known private
sources, this genuinely unrecoverable case has exactly one user-facing step:
**Sign in again to this ChatGPT account.** This is authentication failure, not
account exclusivity; no sandbox cleanup or internal renewal-mode instruction is
shown to the owner.

## Public output during transition

Authenticated late observations append encrypted redaction leaves without
changing broker auth or refresh intent. Refresh commits preserve leaves and
per-guest delivery evidence arriving during the vendor call. Known running Boat
homes are sampled privately before output; a secure exact-capability proof also
checks that the old managed marker is absent. A partially installed home repairs
automatically before its next prompt and cannot certify public output meanwhile.

A sealed delivery receipt for the exact sandbox lifecycle generation allows safe
stopped Boat output without SSH. Raw auth observations invalidate that receipt;
pre-exec observations do not certify later output. Unknown or changed-generation
stopped sources remain withheld until a fresh private observation is possible.
These are output safety checks, not account reservations or usage limits.

Deployment validation additionally covers an older refresh-bearing runtime with
a prompt in flight during adoption on Boat and Modal: launch another sandbox,
then prompt the old one and renew both through the server. Verify late access and
refresh tokens stay redacted. Synthetic tests do not claim deployed success.
