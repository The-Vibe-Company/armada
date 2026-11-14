# Private repositories and installation-scoped checkout

Issue #1694: five public repositories clone successfully; the first private one
fails with Git exit128 after admission. Admission checks caller repository access
through GitHub's API; it is not evidence that the clone credential was delivered
successfully or that a different App token can read contents. An empty installation
list in a separate status response does not identify the token used by an old build.

## Two separate defects

1. The transient checkout helper rejected Git authentication-challenge metadata.
   Public clones generally do not exercise the helper; private clones do. #1706
   reproduces and repairs this with a synthetic credential protocol test, plus
   safe per-requested-repository Git reasons. It does not claim an unseen production
   stderr line was recovered.
2. GoldenCreateService previously minted only when the entire repository set had
   one nonzero installation ID. A public/unassociated repository (ID0) mixed with
   a private installation, or two installation IDs, switched the whole build to
   the cached caller token. Matching an installation by account alone could also
   choose another App installed on the same organization, despite only one App's
   signing key being configured.

## Checkout policy now

- Caller authorization still runs first. An App token never elevates access to a
  repository the caller was not authorized to request.
- Match the configured signing App ID as well as the repository account. A private
  repo visible only under another App refuses with grant-access instructions; it
  is never minted with the wrong key or silently downgraded to another App.
- Mint once per positive installation ID, restricted to that installation's
  requested repository IDs with contents:read. Mixed installations no longer
  cause an all-or-nothing caller-token fallback.
- Each contiguous repository group gets only its matching token via pinned SSH
  stdin. Preserve repository order. For multiple groups, clone frames finish
  before one credential-free baseline/init pass over all repositories.
- Recheck the durable job fence before each SSH group/baseline. Revoke all issued
  tokens on success, checkout failure or partial mint failure. Never revoke the
  caller's own token. No token enters script text, argv, fixture logs or the golden.
- Public/unassociated repositories, or deployments with no installation signing
  credentials, retain the caller-token path. That cached token must have at least
  one hour remaining (refresh otherwise); the challenge-safe helper still applies.
  Installation-based private checkout requires GITHUB_APP_ID and
  GITHUB_APP_PRIVATE_KEY for the intended App plus its repository contents grant.

## Affected paths

| Path | Shared failure / effect of this PR |
| --- | --- |
| Boat golden create/update, including --add-repo | Shared GoldenCreateService and transient helper. Fixes both the helper challenge defect (stacked #1706) and multi-installation token selection; failed rebuild keeps the last-good golden. |
| Modal golden create/update | Same GoldenCreateService/helper/token selection, so the same repair applies. Provider bindings and builder cleanup policy are unchanged. |
| Docker host snapshots | Uses the same goldenCheckoutScript, so it receives #1706's challenge repair. Its server admission separately chooses one token and sends one BuildKit secret; mixed-installation caller fallback still exists there. This PR improves its shared authorizer's App-ID matching and read-only mint scope, but does not add a multi-token Docker wire/BuildKit transport. Do not claim per-installation Docker checkout is fixed or production-verified. |
| Plain launch --repo | Selects a configured repository directory/owner-repo as working directory; it does not add or clone an arbitrary URL. Native initialization pulls configured repositories with a separate user credential setup/broker (gitSetupCommand), not this installation-selection or transient-helper path. It can have separate user-token authorization failures, but is not this clone-selection bug. Runtime/provider restrictions retain their own lifecycle. |

No production repository was read or rebuilt by this worker. Tests prove two
installations plus five public repositories/one private checkout receive their
correct scoped credentials, all tokens are revoked, and baseline/init runs once.
Production confirmation remains the coordinator's authorized post-release retry.
