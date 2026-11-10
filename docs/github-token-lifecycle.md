# GitHub token lifecycle and incident #879

## Established mechanism, not a production attribution

[GitHub documents](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)
that exchanging a refresh token invalidates **both** the old refresh token and its
access token. An eight-hour advertised expiry is not a guarantee that an injected
token remains valid for eight hours. Refresh elsewhere can invalidate it sooner.
No token-count-limit hypothesis is needed to explain that mechanism.

Current `resolveGitHubAccess` already persists one encrypted access token per
owner, serializes refresh under the owner lock, reuses it outside the five-minute
expiry margin and checks `GET /user` before returning it. A cached 401 triggers
one serialized renewal. Neither concurrent nor sequential launches should rotate
a healthy token. The regression in `packages/core/test/github.test.ts` models
GitHub's invalidation rule and checks twelve concurrent plus twelve sequential
resolutions, then demonstrates the effect of a genuine expiry-driven rotation.
It does not establish which server revision or refresh caller caused the reported
production incident; that requires deployment/incident evidence. Do not describe
this PR as proving that the current resolver refreshes on every launch.

## Recovery and runtime gate

A static `GH_TOKEN` already inherited by a running process cannot be repaired by
updating the database cache or reconnecting the account. Reconnecting also changes
the connection epoch. Never paste tokens into `exec`, prompts, command arguments,
logs or repository files as a workaround.

The existing managed GitHub runtime obtains validated tokens on demand instead
of relying on the launch token. It is opt-in via
`ARMADA_GITHUB_RUNTIME_ENABLED=true`; this document does not enable it or authorize
a production change. With that runtime enabled and supported by the provider,
the next normal `armada send <sandbox> "..."` reconciles the running sandbox's
broker before the prompt. Stop/resume also reconciles the physical generation.
This is the existing recovery route without relaunching. Its staging smoke gates
(#822/#830/#825) must pass before an operator enables it. While the gate is off,
there is no supported in-place legacy token repair command: this remains an
explicit delivery gap for #879, not an implicit deployment prerequisite to hide.

## Operator production check (not run by this PR)

1. Record the deployed revision and runtime gate state, without recording tokens.
2. Launch twelve idle sandboxes as one owner, mixing concurrent and sequential
   launches. Run `gh api user --jq .login` in each; record status and login only.
3. Launch a thirteenth, then recheck all thirteen. Every login must still match.
4. In an isolated staging account, exercise expiry-driven renewal and recheck
   older sandboxes through the managed wrappers. Confirm recovery on the next
   prompt and after resume. Do not force rotation on a production account.
5. A rejected launch token must produce a non-connected GitHub status/message,
   never a successful GitHub setup claim. Provider/model launch may still succeed.
