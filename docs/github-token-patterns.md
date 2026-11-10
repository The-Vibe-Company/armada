# GitHub access in long-running workspaces: source survey

Reviewed 2026-11-10 for #879. Links pin inspected commits, not moving branches.
This distinguishes **automatic credential acquisition** from supplying a token
once. No helper can mutate an existing process's environment: survival means a
later authentication/tool call consults a live source. An already-authorized HTTP
request or a client retaining its own token can still fail and require retry.

## Comparable implementations

### Coder — control-plane refresh, workspace askpass

At `coder/coder` commit `73643176b64196c7d2885bb934387e5f46313fb6`,
[`cli/gitaskpass.go`](https://github.com/coder/coder/blob/73643176b64196c7d2885bb934387e5f46313fb6/cli/gitaskpass.go)
uses the workspace agent's authentication to request external auth for the Git
host. [`coderd/workspaceagents.go`](https://github.com/coder/coder/blob/73643176b64196c7d2885bb934387e5f46313fb6/coderd/workspaceagents.go)
loads the owner's server-side external-auth link and calls
[`Config.RefreshToken`](https://github.com/coder/coder/blob/73643176b64196c7d2885bb934387e5f46313fb6/coderd/externalauth/externalauth.go).
Access/refresh credentials remain in the control-plane database; refresh has
singleflight plus a database lease. A running shell's next Git authentication
asks again, without restarting the workspace. Missing/revoked grants lead to
reauthorization or an error; unknown providers fall back to normal Git behavior.
This does not refresh arbitrary `GITHUB_TOKEN` environment snapshots.

### GitHub CLI — local credential owner, not a remote token service

At `cli/cli` commit `18138654f3598ebe031ad7b661c903188f0f1dc9`,
[`pkg/cmd/auth/gitcredential/helper.go`](https://github.com/cli/cli/blob/18138654f3598ebe031ad7b661c903188f0f1dc9/pkg/cmd/auth/gitcredential/helper.go)
asks `ActiveTokenWithRefresh` before answering Git's credential protocol.
[`internal/config/config.go`](https://github.com/cli/cli/blob/18138654f3598ebe031ad7b661c903188f0f1dc9/internal/config/config.go)
resolves stored per-user credentials (keyring/config); refreshable credentials
include the rotating refresh secret on that CLI host. Git 2.46+ capability support
lets the helper mark refreshable replies ephemeral, preventing stale caching.
Rejected refresh grants require login again. Later Git operations can acquire a
new token, but `GH_TOKEN`/`GITHUB_TOKEN` overrides are used as supplied, not renewed.
This is inspected source behavior, not a claim that Armada's installed `gh`
version has this refreshable-login feature. Giving every sandbox the same refresh
secret would reintroduce rotation races; it is not the Armada recommendation.

### Codespaces — public integration evidence; proprietary platform boundary

The Codespaces platform's refresh implementation was not available for this
source review; its durable-secret location and refresh protocol are **unverified**.
GitHub [documents its stock helper path](https://github.com/github/docs/blob/404a5f4de6cd5311e3ce2d5c076571291e0107d6/content/codespaces/troubleshooting/troubleshooting-gpg-verification-for-github-codespaces.md)
(`github/docs`, commit `404a5f4de6cd5311e3ce2d5c076571291e0107d6`).
Concrete public integration code exists in `n8n-io/n8n` commit
`9f48ac9db40d12f3dbaac75b604de36690f1a37a`:
[`gitcredential-refresh.sh`](https://github.com/n8n-io/n8n/blob/9f48ac9db40d12f3dbaac75b604de36690f1a37a/.devcontainer/codespaces/gitcredential-refresh.sh)
and [`gh-shim.sh`](https://github.com/n8n-io/n8n/blob/9f48ac9db40d12f3dbaac75b604de36690f1a37a/.devcontainer/codespaces/gh-shim.sh)
re-read the platform-delivered shared environment file through
[`codespaces-env.sh`](https://github.com/n8n-io/n8n/blob/9f48ac9db40d12f3dbaac75b604de36690f1a37a/.devcontainer/codespaces/codespaces-env.sh)
on each invocation, then delegate to the stock helper/real gh. Thus an old shell's
next child can use the updated token; its inherited environment is not rewritten.
Missing/stale platform updates still cause failed authentication. This is evidence
of the re-read-at-use pattern, not proof of Codespaces' private refresh internals.

### Gitpod / Ona lineage — supervisor lookup plus server refresh

Historical public `gitpod-io/gitpod`, commit
`beff6f390122506f5edd9342b00b8d45063ccdfa`:
[`credential-helper.go`](https://github.com/gitpod-io/gitpod/blob/beff6f390122506f5edd9342b00b8d45063ccdfa/components/gitpod-cli/cmd/credential-helper.go)
asks the supervisor;
[`GitTokenProvider`](https://github.com/gitpod-io/gitpod/blob/beff6f390122506f5edd9342b00b8d45063ccdfa/components/supervisor/pkg/supervisor/git.go)
fetches from the server and marks replies `REUSE_NEVER`.
[`token-service.ts`](https://github.com/gitpod-io/gitpod/blob/beff6f390122506f5edd9342b00b8d45063ccdfa/components/server/src/user/token-service.ts)
requires five minutes' remaining life and serializes refresh with Redis; encrypted
DB credentials and rotated values are handled by
[`generic-auth-provider.ts`](https://github.com/gitpod-io/gitpod/blob/beff6f390122506f5edd9342b00b8d45063ccdfa/components/server/src/auth/generic-auth-provider.ts).
Later Git operations from an existing process re-query; failed refresh/missing
tokens fail acquisition. Caveat:
[server/supervisor mapping](https://github.com/gitpod-io/gitpod/blob/beff6f390122506f5edd9342b00b8d45063ccdfa/components/supervisor/pkg/serverapi/publicapi.go)
also carries `RefreshToken`, although GitTokenProvider returns only the access
token to Git. Do not claim the refresh secret never enters workspace control
code. This is the public Gitpod implementation, not verified current Ona service
behavior; nonexpiring provider grants do not exercise its refresh branch.

### DevPod — forward to the user's local credential owner

`loft-sh/devpod`, commit `5a0efcbff6610ab114b421f68a890739a452e66b`:
[`cmd/agent/git_credentials.go`](https://github.com/loft-sh/devpod/blob/5a0efcbff6610ab114b421f68a890739a452e66b/cmd/agent/git_credentials.go)
asks a workspace credentials service, with a forwarded local-machine fallback.
The [tunnel handler](https://github.com/loft-sh/devpod/blob/5a0efcbff6610ab114b421f68a890739a452e66b/pkg/agent/tunnelserver/tunnelserver.go)
uses [`pkg/gitcredentials/gitcredentials.go`](https://github.com/loft-sh/devpod/blob/5a0efcbff6610ab114b421f68a890739a452e66b/pkg/gitcredentials/gitcredentials.go)
to run local `git credential fill`. Long-lived secrets remain with that local
credential provider; only its answer is forwarded. Already-running agents can ask
again on later Git operations, but automatic expiry handling depends on the local
helper, not a DevPod GitHub refresh implementation. A dead tunnel/service or a
local helper returning an expired token produces missing/failed credentials.
The optional platform branch returning stored HTTP credentials is not evidence
that those values automatically renew.

### OpenHands — historical action-boundary refresh, with a license boundary

Current `OpenHands/OpenHands`, commit
[`2e9c992d67065271d9756eba5b8cfa1cae018f6f`, `src/api/cloud/git-service.api.ts`](https://github.com/OpenHands/OpenHands/blob/2e9c992d67065271d9756eba5b8cfa1cae018f6f/src/api/cloud/git-service.api.ts),
proxies an external App API; current cloud token storage/refresh is unverified.
Historical OSS release 0.62.0, commit
`7fbb48c40679afd674970966b96185657d92a487`,
[`openhands/runtime/base.py`](https://github.com/OpenHands/OpenHands/blob/7fbb48c40679afd674970966b96185657d92a487/openhands/runtime/base.py)
and [`integrations/provider.py`](https://github.com/OpenHands/OpenHands/blob/7fbb48c40679afd674970966b96185657d92a487/openhands/integrations/provider.py),
refresh supported command actions mentioning a provider-token variable via
`/api/refresh-tokens`, authenticated by the conversation, then export to the
persistent shell/IPython. Existing children and copied authenticated remotes are
not rewritten; missing broker configuration/errors leave old credentials usable
only until invalidated/expired. Historical server refresh/storage implementation
is in [`enterprise/server/auth/token_manager.py`](https://github.com/OpenHands/OpenHands/blob/7fbb48c40679afd674970966b96185657d92a487/enterprise/server/auth/token_manager.py):
encrypted access/refresh tokens, refreshed ahead of expiry. That server code has
[PolyForm trial terms](https://github.com/OpenHands/OpenHands/blob/7fbb48c40679afd674970966b96185657d92a487/enterprise/LICENSE),
**not the OSS runtime license**. This is a source-visible comparison, not proof of
current hosted behavior or universal remote-shell renewal.

### Daytona — caller-supplied credentials, not proven renewal

Current `daytonaio/daytona` [README at `ec4c21b2d597091ac09ecc278f3bcc172575a987`](https://github.com/daytonaio/daytona/blob/ec4c21b2d597091ac09ecc278f3bcc172575a987/README.md)
says core development moved private. Inspectable **historical** OSS v0.190.0,
commit `01c502bb1f1ff8f2885d0cd490e043736083dca8`,
[`libs/sdk-typescript/src/Git.ts`](https://github.com/daytonaio/daytona/blob/01c502bb1f1ff8f2885d0cd490e043736083dca8/libs/sdk-typescript/src/Git.ts),
accepts username/password/token per clone/push/pull request and forwards them to
the toolbox API. The caller owns long-lived-secret storage and renewal; this SDK
path contains no OAuth-refresh broker. A running caller can supply a new token on
a later operation, but a copied environment value stays stale. Expired credentials
fail upstream Git authentication. No claim is made about the current private
platform or a separate caller-provided integration.

### T3 Code — server-side credentials; not a sandbox-renewal precedent

At `pingdotgg/t3code` commit `f12bb6229c007a12d24fd2e539222733778ac9ea`,
[`GitHubAppSignIn.ts`](https://github.com/pingdotgg/t3code/blob/f12bb6229c007a12d24fd2e539222733778ac9ea/packages/source-control-github/src/server/GitHubAppSignIn.ts)
keeps the App session/refresh token in server source-control settings and refreshes
on token acquisition with serialization and replacement checks; rejected refresh
grants sign out. [`GitHubCredentials.ts`](https://github.com/pingdotgg/t3code/blob/f12bb6229c007a12d24fd2e539222733778ac9ea/packages/source-control-github/src/server/GitHubCredentials.ts)
resolves settings/env/`gh auth token`, with a five-minute cache for that lookup.
A running server can acquire updated App credentials, but static env overrides
remain static. [`RemoteDelegation.ts`](https://github.com/pingdotgg/t3code/blob/f12bb6229c007a12d24fd2e539222733778ac9ea/apps/server/src/peer/RemoteDelegation.ts)
launches ordinary threads on linked environments. These inspected paths do not
establish an automatically refreshed Git credential helper inside remote
sandboxes; do not infer that capability from “remote” task support. Ordinary Git
credentials still depend on the environment executing Git.

## What this means for Armada

For automatic credential delivery, the surveyed pattern is **workspace helper →
narrow local broker → authenticated control-plane acquisition**, not periodic
environment snapshots. This describes option 2, not a decision that GitHub secrets
belong in guests. The [broader options comparison](github-delivery-options.md)
recommends credential-free publish-by-bundle instead. Armada's already-merged
managed runtime matches the Coder/Gitpod-style division:

- The encrypted rotating GitHub refresh token stays server-side in
  `github_connections`; `resolveGitHubAccess` shares and serializes owner refresh.
- [`GitHubBroker.acquire`](../packages/agent-runtime/src/github-broker.ts) calls
  `/api/internal/github/credentials` over HTTPS with a sandbox capability.
  [`github-runtime.ts`](../packages/mcp-server/src/github-runtime.ts) checks owner,
  repository, org, connection epoch, backend/physical generation and lifecycle
  before and after resolution; the guest never supplies a different owner.
- [`github-tools.ts`](../packages/agent-runtime/src/github-tools.ts) installs
  git/gh wrappers and owner-private local IPC. New invocations acquire live
  credentials even from an old native process. Retired credentials are retained
  for redaction; broker failure must not break offline Git or kill the harness.

**Missing to enable it is operational proof, not another token cache.**
`ARMADA_GITHUB_RUNTIME_ENABLED` remains off. Follow
[`docs/github-runtime.md`](github-runtime.md) and
[`#822`](https://github.com/The-Vibe-Company/armada/issues/822)/
[`#825`](https://github.com/The-Vibe-Company/armada/issues/825): gate-off stock
baseline, then staging gate-on checks across Boat/Modal × Claude/Codex. Merged
[#830](https://github.com/The-Vibe-Company/armada/pull/830) automates fresh native
Git/push, exec reads, a second native turn and cleanup, but deliberately reports
`enablement.complete=false`. Still require expiry/renewal **inside an already
running native turn**, unchanged VM/PID-start-time/conversation, and bounded broker
stall/stop/restart with local Git and harness survival. The documented staging
SQL/Boat fault procedure is manual; Modal's broker shares its Runner and still
needs isolated guarded fault controls/evidence in #825. No staging results were
supplied here, so this survey does not authorize flipping the gate. Rollback also
requires retiring affected workers: gate-off does not uninstall existing wrappers.

The small #879 fix remains independently useful: a new sandbox must receive more
than one hour of advertised remaining life, and `armada github refresh <sandbox>`
repairs running legacy Boat workers through private stdin plus an ephemeral file.
**The command is explicit recovery, not per-command automatic refresh.** PR #881
also repairs legacy Boat credentials before each authorized next prompt; an
already-running turn can still need the explicit command. Neither is instant
fan-out or a replacement for an on-demand runtime after proof.
