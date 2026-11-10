# GitHub delivery from untrusted sandboxes: options, not just tokens

Decision proposal for #879, 2026-11-10. **Recommend option 6: explicit server-side
publish-by-bundle as the default managed delivery path.** Keep the minimal
one-hour remaining-lifetime guard independently shippable. This document does not
implement the proposal, enable the gated runtime, or authorize a deployment.
The legacy explicit/next-prompt repair in PR #881 is a tactical bridge, not the recommendation.

## Separate authorship from authority

All six options can read a supplied checkout and create **local commits without
GitHub credentials**. Git author/committer name and email are object metadata,
not the identity that authenticates a push. Using an installation token does
**not** automatically rewrite existing commits to an App author. Set the owner's
chosen verified/noreply email; bundles preserve existing commit IDs/signatures.
`Co-authored-by` trailers can credit a person, but neither metadata nor trailers
prove the person's consent or create a verified personal signature. See
[commit email](https://docs.github.com/en/account-and-profile/how-tos/email-preferences/setting-your-commit-email-address)
and [co-authorship](https://docs.github.com/en/pull-requests/how-tos/commit-changes/creating-a-commit-with-multiple-authors).

Push/API actor is separate: an installation token acts as the App/bot, including
PRs/comments/audit identity; a user-to-server token acts on behalf of the user.
Human commit credit does not make an App-created PR human-authored. If “as owner”
requires the person's GitHub API actor, options 4/6 must use server-held user
access, not silently substitute an installation token. See
[App versus user identity](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps).

## Comparison

Effort is relative to the current Armada source, not a delivery estimate. Every
proposal must recheck current owner access, repository and operation authorization;
“no GitHub credential” does **not** mean “no authority to steal.” A compromised
agent can still misuse whatever Armada operations it is allowed to request.

### 1. Static user token at launch — current baseline

- **Guest secret/blast radius:** a copied user access token, originally up to eight
  hours but only its remaining owner-window at launch. Theft permits the token's
  GitHub user/App access, not merely the selected checkout; Armada repository
  checks cannot constrain direct GitHub use after exfiltration.
- **Git/gh:** ordinary private fetch/push and permitted gh APIs work directly;
  local commit never needs this token. gh's env override is not automatic renewal.
- **Expiry/lifecycle:** owner refresh invalidates old copies, including those in
  already-running agents. Stop/resume or a saved environment can restore a stale
  value. Never bake it into a golden/image; advertised lifetime is not a promise
  against revocation. The #879 launch guard reduces nearly-expired handouts but
  does not solve the architecture; explicit legacy repair is still manual.
- **Effort/portability:** lowest effort; env injection works in Docker/Kubernetes
  but retains precisely this failure mode. Restarting Pods is not credential
  rotation for running agents.

### 2. User-token helper/local broker — Armada's gated runtime

- **Guest secret/blast radius:** a narrow Armada capability for its lifecycle,
  plus a current short-lived user access token during privileged child execution.
  The GitHub refresh secret stays encrypted server-side. Broker checks limit
  issuance; a compromised guest that steals the issued token can bypass those
  checks at GitHub until invalidation/expiry, so issuance scope is not token scope.
- **Git/gh:** wrappers acquire at use; ordinary supported Git/gh flows keep working
  for existing agents without changing their parent env. Raw-token caching or
  bypassing wrappers does not gain renewal.
- **Expiry/lifecycle:** the server serializes owner renewal; later calls acquire
  again. Lost broker/control plane means remote auth fails closed, while offline
  Git must work. Rebind capability and reconfigure broker after resume/checkpoint;
  do not restore old capabilities/tokens as authority for a new physical generation.
- **Effort/portability:** lowest automatic-renewal implementation delta: broker,
  wrappers and server endpoint already exist. Still gated pending the full
  same-VM/native-session renewal and broker-fault evidence in #822/#825. Unix
  sockets/sidecars suit containers; native wrapper, redaction and identity checks
  still need validation per backend. It is a compatibility choice, not mandatory
  simply because it is already built.

### 3. Per-sandbox GitHub App installation tokens — different GitHub principal

- **Guest secret/blast radius:** a newly minted installation token, one hour,
  restricted to authorized launch repositories and explicit minimal permissions.
  The App signing key remains server-only. A stolen token can act as the App within
  those grants until expiry/revocation; repository scope is not branch scope.
- **Git/gh:** Git contents read/write and gh endpoints supported by installation
  auth work. User-only APIs do not. PRs/comments act as the App; local commits can
  still credit the person as explained above. Required Contents/PR permissions,
  organization policy, fork workflows and branch rules need explicit design.
- **Expiry/lifecycle:** re-mint on demand using a helper/broker (merely copying a
  one-hour token repeats option 1). No shared rotating user refresh token. Revoke
  issued tokens on retirement and reauthorize/re-mint after resume/checkpoint.
- **Effort/portability:** medium. `github-installation.ts` already mints/revokes for
  goldens, but currently sends `repository_ids` **without a `permissions` reduction**;
  extend it before treating it as least-privilege sandbox issuance. Reuse
  `golden-github.ts`'s owner authorization principle: installation access must not
  elevate a person. Handle multiple installations separately. Same broker/sidecar
  model works for Docker/Kubernetes, without shipping the signing key.

GitHub documents [one-hour lifetime, repository and permission narrowing](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).

### 4. Armada-side Git relay/proxy + explicit API tools — no guest GitHub credential

- **Guest secret/blast radius:** only a renewable Armada workload identity, scoped
  to sandbox/generation/repository/operations; GitHub user/App credentials stay
  server-side. Theft permits allowed relay/tools actions, not arbitrary GitHub APIs.
  The relay must enforce allowed refs/actions, owner access and lifecycle on every
  request; a generic authenticated forwarding proxy would not provide this benefit.
- **Git/gh:** ordinary Git remote operations target Armada smart-HTTP/SSH endpoints;
  local commit remains unchanged. Stock gh cannot talk to GitHub privately without
  credentials. Replace PR/comment/check operations with bounded Armada tools;
  an optional shim can support a documented subset, not arbitrary gh commands.
- **Expiry/lifecycle:** new requests resolve fresh upstream access; expired workload
  identity must renew too. Rebind after resume/checkpoint, deny old generations.
  A network transaction can fail mid-flight: inspect receipts/remote refs rather
  than blindly replaying a possibly accepted push. Control-plane outage blocks
  remote work, not offline Git.
- **Effort/portability:** high: no Git relay exists. Needs smart protocol/pack and
  receive-pack ref policy, streaming limits, LFS/submodule handling, canonical
  upstream/SSRF protection, durable outcomes and sanitized logs. Container-friendly:
  central egress service plus mTLS/short-lived workload identity; no GitHub secret
  mounted in Pods. More Git UX compatibility than option 6, more protocol surface.

### 5. Per-sandbox repository SSH keys/certificates + Armada API tools

- **Guest secret/blast radius:** a private deploy key for one repository, or an SSH
  private key plus certificate. A GitHub deploy key has **no native expiry**:
  “short-lived” requires Armada to delete it on schedule/retirement, even after an
  unclean stop. Write keys permit repository writes until removed. GitHub SSH user
  certificates are not automatically repository-scoped deploy keys: CA/user trust
  can cover wider organization access; availability/policy depends on Enterprise.
- **Git/gh:** SSH Git reads/pushes work with host-key pinning; no authenticated gh
  API access. PR/comment/check actions still need Armada tools. Preserve human
  commit metadata independently of SSH authentication.
- **Expiry/lifecycle:** key/certificate theft survives a guest stop unless revoked
  or genuinely expired. Reissue per physical generation, clean up deploy-key IDs
  out of band, never checkpoint keys for reuse. Certificates need a renewal path
  and have GitHub-specific revocation limitations; do not assume one can revoke
  an individual certificate while continuing to trust its CA.
- **Effort/portability:** medium/high: repository admin authority, provisioning,
  revocation and multiple-repository key selection are new. Crucial correction:
  the golden builder's `sshStdinCheckout` key authenticates **to the sandbox**, not
  to GitHub; Git checkout there still uses an HTTPS token over stdin. It is not an
  existing deploy-key issuer. Pod-mounted/agent-held keys are portable but still
  expose GitHub authority and need cleanup independent of Pod termination.

See [deploy-key scope/no expiry](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys)
and [GitHub SSH certificate trust/revocation](https://docs.github.com/en/enterprise-cloud%40latest/organizations/managing-git-access-to-your-organizations-repositories/about-ssh-certificate-authorities).

### 6. Publish-by-bundle + Armada API tools — recommended managed delivery target

- **Guest secret/blast radius:** no GitHub token, key or refresh secret. Owner
  initiates publication, or grants a narrow renewable Armada publish capability
  for approved repository/branch actions. Compromise can submit malicious work or
  misuse allowed tools; it must not grant arbitrary refs, force-push, merges,
  deletion or a general owner-authenticated GitHub proxy.
- **Read/commit/push/PR:** Armada supplies authorized private repository snapshots
  or incremental bundles; agent reads and commits locally. Public unauthenticated
  reads remain possible. An explicit `publish` operation collects the selected
  committed tip, pushes server-side and optionally opens a PR **as owner** using
  server-held user access. Branch updates/read checks/comments use explicit tools.
  No transparent private gh CLI; no automatic committing of dirty files.
- **Expiry/lifecycle:** server resolves fresh GitHub access per operation. Existing
  guest env is irrelevant; service outage queues/rejects publication with a closed
  receipt while local work continues. Reauthorize after resume/checkpoint, bind
  artifact digest/tip/repository/target ref and use idempotent operation IDs with
  remote-ref reconciliation after uncertain pushes. A preserved archive is not
  permission to publish, and cannot recover work never captured before VM loss.
- **Effort/portability:** medium and bounded for a restricted delivery workflow,
  not a zero-effort reuse. #747's provider-neutral collector already encrypts and
  transports unpublished `commits.bundle` plus dirty-work recovery; it does **not**
  push/open PRs. Current archive cap is 2 MiB, bundles can need upstream prerequisite
  objects, and external LFS/submodule objects are not promised. Add explicit live
  collection, authorized private reads, a bounded isolated importer/uploader,
  prerequisite validation, size policy, PR tools and durable receipts. Never run
  guest hooks/filters/config or untrusted checkout/build scripts beside server
  secrets. Use a separately constrained importer, not the main API process.
  Provider-neutral artifacts and server egress fit Docker/Kubernetes Jobs well;
  keep authority outside container images/checkpoints and handle storage retention.

## Recommendation and sequence

**Choose 6 for managed agent delivery**: the required workflow is read → local
commit → publish → PR, not necessarily “arbitrary gh with the owner's account.”
It removes GitHub credential exfiltration from the guest, retains exact commit
objects, and reuses preservation/credential resolution without implementing a Git
transport proxy. It remains a launcher operation explicitly requested by an
owner/agent, not a fleet orchestrator, merge queue or automatic deployer.

Tradeoff: this intentionally sacrifices transparent private Git/gh networking.
If unrestricted interactive Git compatibility is a hard requirement, option 4 is
the credential-free alternative worth a separate design; option 2 is the smaller
compatibility path only after its gated smoke is complete. Option 3 is attractive
for opt-in **App identity**, but does not satisfy a strict human PR actor contract.
Option 5 trades OAuth rotation for key/CA lifecycle and is not a universal shortcut.

1. Ship the minimal remaining-lifetime guard independently; it prevents one acute
   failure without selecting an architecture. Existing explicit/next-prompt legacy
   repair is a bridge, not per-command automatic renewal or this recommendation.
2. Get owner acceptance of the tool-based publish contract, size/LFS limits and
   human-versus-App API identity. No option 6 implementation is authorized by this
   proposal. Treat the already-authored legacy bridge separately from that decision.
3. Implement option 6 in a focused follow-up: one authorized live artifact publish,
   scoped branch, one PR operation, bounded import and uncertain-outcome recovery;
   keep #747 preservation unchanged as the failure-path safety net.

## Mapping the inspected open-source systems

See [commit-pinned survey](github-token-patterns.md) for files and caveats.
Coder and Gitpod are option 2; DevPod forwards a local credential owner (option-2
family), not a GitHub relay. gh is a local refreshable-helper component usable by
option 2; env tokens remain option 1. The inspected Codespaces/n8n wrappers re-read
platform credentials (option-2 family), not credential-free Git relay evidence.
Historical OpenHands action-boundary env refresh is between options 1/2, not proof
of arbitrary process renewal; its server broker code has a separate enterprise
license. Historical Daytona SDK callers supply credentials per request (option 1
unless the caller adds a broker). T3 Code has server-side acquisition, not evidence
of a remote guest relay. None of these inspected paths proves option 4 or 6 as a
complete managed Git workflow; Armada's #747 collector is the concrete reusable
part for 6, not an upstream precedent or an already implemented publish service.

Local source: [`github-installation.ts`](../packages/core/src/github-installation.ts),
[`golden-github.ts`](../packages/core/src/golden-github.ts),
[`ssh-executor.ts`](../packages/core/src/ssh-executor.ts),
[`work-preservation.ts`](../packages/core/src/work-preservation.ts),
[`collector`](../packages/core/src/work-preservation-collector.ts),
[recovery limits](work-preservation.md).
