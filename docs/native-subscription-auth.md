# Native subscription authentication

## Shared accounts (#1248)

Subscription accounts work like API keys: any number of sandboxes can use the
same account simultaneously. A failed, deleted, stopped or unregistered earlier
sandbox does not reserve an account. There is no holder, release or reconcile
step before launching or prompting.

Codex uses the server-owned renewal broker from #1186. Each sandbox receives an
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
