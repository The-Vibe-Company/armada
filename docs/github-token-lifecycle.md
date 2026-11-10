# GitHub token lifecycle and incident #879

## Cause

[GitHub documents](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)
that exchanging a refresh token invalidates **both** the old refresh token and its
access token. An eight-hour advertised expiry is not a guarantee that an injected
token remains valid for eight hours after the sandbox starts.

The coordinator supplied this sanitized production timeline (2026-11-10 UTC,
server `2fce2ef6`, deployed 11:31:38): the owner's connection was updated at
11:44:43.28 with access expiry 19:44:43.72. Sandboxes launched at 11:24, 11:34,
11:38, 11:42 and 11:44:28 subsequently failed with 401. Sandboxes launched at
11:44:44 and 11:46 worked. The earlier ones retained the previous owner's token,
not a new eight-hour token of their own. A launch at 11:38 could reuse a token
with about six minutes left because the old cache margin was only five minutes.
The expiry-boundary refresh then invalidated all remaining copies of that token.
No token-count-limit hypothesis is needed. This PR performed no production access.

The regression in `packages/core/test/github.test.ts` models GitHub's invalidation
rule. Twelve concurrent plus twelve sequential resolutions share a healthy token;
a resolution six minutes before expiry must renew it, and the fake GitHub rejects
old copies. `packages/mcp-server/test/github-legacy.test.ts` then proves that all
twelve older Boat workers acquire the valid replacement before their next prompt,
without manual repair commands. That case fails with the former five-minute margin and passes with the
new one-hour minimum remaining lifetime. Unexpectedly short freshly issued tokens
are reported as unavailable rather than injected. Rotation is persisted first so
its refresh token is never replayed.

## Automatic preparation: default off

`ARMADA_GITHUB_LEGACY_AUTO_PREPARE_ENABLED=true` is the trusted server opt-in for
legacy Boat next-prompt preparation. It is **off by default**; only exact `true`
enables it. Keep it off until the coordinator's real-Boat image/SSH/sudo check
below passes. Restart all server replicas after changing it. This is independent
of `ARMADA_GITHUB_RUNTIME_ENABLED`; when the managed runtime is enabled, its path
takes precedence. The one-hour launch safety guard and explicit repair command do
not require either flag.

When opted in, installation is best-effort. SSH, sudo, Python, filesystem or lock
failure logs only a fixed `github_legacy_hydration_failed` event and sandbox ID,
never the exception/cause/token, then lets the prompt proceed. Explicit repair
remains strict and reports failure. The installer waits at most five seconds for
another install's lock, within its 45-second subprocess budget.

## Legacy recovery, without the runtime gate or relaunch

Run as the sandbox's owner:

```sh
armada github refresh <sandbox>
```

The HTTP operation and MCP `github_refresh` tool use the same owner-only policy.
This repairs **running legacy Boat sandboxes** even with
`ARMADA_GITHUB_RUNTIME_ENABLED` disabled. It reuses the owner's current validated
token, renewing only after expiry or explicit rejection. Repair and next-prompt
preparation do not apply the one-hour new-launch margin, so repairing one worker
does not proactively rotate a still-valid token held by its siblings. It does not reconnect the
account, change the model credential, restart the agent, or relaunch the machine.
A stopped sandbox must first be resumed normally. An org admin cannot inject their
identity into somebody else's sandbox.

Private pinned SSH/stdin carries the token; never paste one into `exec`, prompts,
argv, logs or repository files. The repair installs token-aware `gh` and `git`
wrappers so even already-running agents' inherited stale `GH_TOKEN` is overridden
on the next tool invocation. The token lives in ephemeral `/run`, outside the
persisted home and golden snapshot. If the file is absent or expired, wrappers
pass through the inherited environment; unsafe ownership/symlinks still fail closed.
With the legacy automatic flag enabled, before each authorized Boat prompt
(including after resume), Armada resolves the
stored sandbox owner and privately hydrates the current token automatically.
Use the explicit repair command to repair an already-running turn before retrying
Git/gh without sending a new prompt.
Absolute preserved `.armada-original` binaries, custom clients that read the old
environment directly, and already-started network requests are not updated.

The one-hour launch minimum avoids handing a new sandbox a nearly expired token;
it is not a promise against revocation or another refresh. Legacy environments
can recover at the next prompt only when the opt-in is enabled, not instantly
inside an already-running turn. With the default-off setting, use explicit repair. For
automatic per-command renewal,
the existing managed GitHub runtime remains separately opt-in via
`ARMADA_GITHUB_RUNTIME_ENABLED=true`: next-prompt and resume reconciliation install
its broker, whose wrappers fetch validated credentials on demand. This PR neither
changes that gate nor deploys it; #822/#830/#825 cover its enablement smoke checks.
When the managed runtime is active, use the next normal prompt to reconcile it,
not the legacy repair command.

## Optional GitHub availability

Automatic preparation does not prevent local/model work when GitHub is unavailable,
revoked or not configured: it injects no new access material and lets the prompt
proceed. Explicit `armada github refresh` instead returns the closed failure so a
caller does not mistake it for a successful repair. Owner membership refusal remains closed. Automatic installation/transport failures
are best-effort as described above; explicit repair still fails closed for unsafe
filesystem/private-transport failures. This
availability policy does not make a stale inherited token valid.

## Operator production check (not run by this PR)

1. Record deployed revision and runtime gate state, without recording tokens.
2. Launch twelve idle sandboxes as one owner, mixing concurrent and sequential
   launches. Run `gh api user --jq .login` in each; record status and login only.
3. Launch a thirteenth, then recheck all thirteen. Every login must still match.
4. In an isolated staging account, enable the legacy automatic flag for the
   coordinator check, verify actual image/SSH/sudo behavior, and exercise expiry-driven renewal. Confirm the
   next prompt automatically repairs every older running Boat sandbox, without
   relaunching or twelve manual repair commands. Also check the explicit refresh
   command for an already-active turn,
   including agents whose inherited environment is stale. Recheck `gh api user`
   and a git credential operation. With managed runtime enabled, also test
   next-prompt and resume recovery. Do not force rotation in production.
5. A rejected or short-lived launch token must produce a non-connected GitHub
   status/message, never a successful GitHub setup claim. Provider/model launch
   may still succeed.

## Repeated-install optimization

An expiry-only server cache is deliberately not used: `/run` can be cleared on
resume/reboot while the owner token remains unchanged. Boat metadata does not
currently give this path a trusted physical-generation acknowledgement, so caching
“already hydrated” could skip the repair that is needed most. A generation-bound
acknowledged cache is a follow-up optimization; it is not required to enable the
experimental flag after the real-image check.
