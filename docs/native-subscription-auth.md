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

## Device-login completion and diagnostics (#1579)

Run native sign-in from a persistent terminal. This is a foreground operation,
not a resumable background login: **the Armada process must remain alive until
it says the account was imported**. Browser approval alone does not publish an
Armada account. Closing its shell/SSH command runner cancels the operation;
SIGHUP, SIGTERM and Ctrl-C are diagnosed and the isolated native process/home
are cleaned up. SIGKILL cannot be caught or resumed. For a remote session, start
`tmux new-session -s armada-codex-login` (or screen) before running the command;
reattach rather than destroying that session while approving in the browser.

For the owner's staging retry, from a checkout containing this CLI fix:

```sh
export ARMADA_URL=https://armada-mcp-staging.up.railway.app
# Keep the owner's Armada staging login/token configured; no provider token in argv.
bun run armada creds login codex --name hello --org STAGING_ORG_NAME
```

The app-server has 30 seconds to initialize and return a device challenge. Once
the official challenge is shown, Armada allows 16 minutes for native approval
and account setup; it no longer cuts off after five minutes. Codex 0.166.0's
[native device poll window is 15 minutes](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/login/src/device_code_auth.rs#L107-L139).
The native process owns its OAuth/device exchange; Armada does not implement a
second login server or retry a possibly consumed authorization code.

Failures identify the boundary without printing native stderr, raw error bodies,
auth.json, tokens, URLs containing credentials or token claims:

| Diagnostic | Meaning |
| --- | --- |
| Could not start Codex / JSON-RPC code and initializing step | Local executable, permissions or native startup/initialization failed. |
| Codex reported device approval expired | Native's device code expired; this is not an Armada account-publication failure. Start a new attempt. |
| Codex reported authorization-code/token exchange failed | Native approval polling reached the exchange, which failed. Provider-controlled details are withheld. |
| Codex reported workspace discovery / requirements failed | Native account setup failed after the device step. Codex can reject completion even after saving tokens; Armada does not import after native `success:false`. |
| Codex approved the login, but wrote no auth.json | Native reported completion but the isolated file was absent; no file-read retry or older login file is used. |
| Approved auth.json contains no access/refresh token | A renewable native credential was not written; nothing is uploaded. |
| Approved auth.json contains no stable ChatGPT account ID | Native permits a nullable ID, but Armada's subscription binding/refresh broker requires it. Do not invent an ID or derive a workspace from an unverified access-token claim; native account/workspace setup must supply it. |
| Parent shell/session closed (SIGHUP) | The foreground owner process was cancelled. Browser approval cannot finish a terminated attempt; retry in a persistent terminal. |
| Local 30-second / 16-minute timeout, or native exit code/signal | Distinguishes startup, waiting for approval/account setup, cancellation and an early native process exit. |

A nonempty refresh token and stable account identity remain mandatory; an API-key
file is not silently relabeled as a subscription. Explicit `--org` remains the
requested publication scope and its normal server admin checks still apply.
The subsequent Armada API write has its own permission/network diagnostics; an
uncertain API response is not rewritten as a native-login failure.

The old generic failure cannot reveal retrospectively which branch an owner's
attempt took. Real 0.166.0 handshake/challenge inspection (isolated home, stopped
before approval) proves that initial protocol shape; it is **not** a completed
owner login or model-turn proof. After retrying, share only the new safe failure
line if needed, never the authentication file or native provider logs.

## If device login still fails: owner recovery (#1581)

First run `codex --version` and keep the safe Armada failure line (including
its step and any HTTP/JSON-RPC code). The bounded check on 2026-11-14 used
**codex-cli 0.166.0** installed separately from the sandbox's 0.169.0 binary:
Armada's real `nativeCodexLogin` started its app-server, received an official
device challenge, then deliberately cancelled before browser approval. It
reported the waiting-for-approval step and no publication. No challenge code,
authentication file or native diagnostic stream was recorded. This checks the
real startup/challenge/cancellation boundary, **not** completed subscription
login, Armada publication or a model turn.

Use this decision order:

1. **Startup/initialization failure:** run `command -v codex` and
   `codex --version` in the same persistent terminal as Armada. Correct the
   executable/PATH or permissions first; do not repeatedly approve browser
   codes for a process that cannot start.
2. **Expired challenge or closed terminal:** start a fresh Armada attempt in
   tmux/screen, approve only its new code and leave that process alive until
   import succeeds. An earlier approval cannot resume a terminated attempt.
3. **Polling, exchange or workspace failure:** isolate native sign-in using the
   temporary-home procedure below. If standalone Codex also fails, the failure
   is upstream of Armada publication. Share only version plus the safe Armada
   stage/code; do not paste native provider errors or `auth.json` into an issue.
4. **Native login succeeds, Armada publication fails:** check the selected
   Armada server, org UUID and account-write permissions. For an uncertain API
   outcome, inspect `armada creds list --org ORG_UUID` before importing again.
   A native success alone does not prove an Armada account exists.

### Standalone native login, then secure import

Run on your own machine in a persistent terminal, with the intended Armada
server/login already selected. Replace `ORG_UUID` and the display name below.
This uses a disposable Codex home and explicitly requests file storage, so it
neither overwrites your usual Codex login nor depends on a keychain file being
available to Armada. The subshell deletes its temporary credentials on exit.
Do not enable shell tracing (`set -x`).

```sh
(
  set -eu
  export CODEX_HOME="$(mktemp -d)"
  trap 'rm -rf "$CODEX_HOME"' EXIT
  codex -c 'cli_auth_credentials_store="file"' login --device-auth
  # Only continue after Codex reports a successful sign-in.
  test -s "$CODEX_HOME/auth.json"
  armada creds import codex --name "Personal ChatGPT" \
    --file "$CODEX_HOME/auth.json" --org ORG_UUID
)
```

If standalone **device** authorization still fails, run the same procedure with
`login` instead of `login --device-auth` on a machine where the native browser
callback can reach Codex. Do not forward or reuse a device code from a failed
attempt. If both native methods fail, resolve native account/workspace access
before retrying Armada; do not fabricate an account ID or replace the
subscription with an API-key file. If import rejects missing renewable tokens
or a stable account ID, no account was published: complete native
account/workspace setup first. The temporary file is deleted even on failure;
a later attempt requires a new native login.

### Completion evidence still required from the owner

- Complete browser approval with 0.166.0 in the foreground and wait for Armada's
  imported-account confirmation (not just the browser's success page).
- Confirm the intended named account in `armada creds list --org ORG_UUID`.
- Coordinator only: launch/follow up on Modal or the authorized Docker host with
  that account and record the safe result. No Boat staging probe.

These three steps have **not** been completed by the bounded local check above.
Do not mark subscription end-to-end acceptance passed from that check or unit
fixtures. If either native login or publication fails, retain the safe boundary
and next action above rather than reporting a generic "login failed".

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
