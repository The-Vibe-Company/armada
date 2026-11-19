# Releasing the CLI to npm

Armada v2 replaces v1 under the existing public package `@the-vibe-company/armada`.
Keep that package name: existing users upgrade with `npm install -g @the-vibe-company/armada`.
The v2 launcher selects one of four optional platform packages, `@the-vibe-company/armada-{linux,darwin}-{x64,arm64}`.
The workspace packages stay private; the compiled binaries bundle their dependencies.
The TypeScript SDK is published as `@the-vibe-company/armada-sdk`: `scripts/npm.ts` bundles
`packages/sdk` with the browser-safe core code it uses and expands core types in its declarations,
so the package has no dependencies.

## Normal releases

1. Merge conventional commits (`feat`, `fix`, breaking changes) into `main`.
2. The Release workflow runs Release Please and opens or updates `chore(release): <version>`.
   It updates the root package, every workspace package, the changelog and the release manifest.
   The workflow also synchronizes Bun's lockfile and explicitly dispatches CI on that PR's branch.
   This explicit dispatch matters: PRs and pushes created with `GITHUB_TOKEN` do not trigger ordinary CI.
3. Review and merge the version PR after its checks pass. The Release workflow freezes a
   same-version main SHA and validates it. It creates the tag and GitHub release after
   the build and exact-source staging smoke pass.
4. After release metadata validates the version and source SHA, `check` runs lint, typecheck,
   release-only contracts and the named sentinel files in parallel with sandbox image preparation.
   Once the image pin is ready, the binary jobs and exact-SHA staging smoke run in parallel while
   `check` can continue. The merge queue runs the ordinary unit suite for the same source tree.
5. Four native runners compile the binaries, pack npm tarballs and run the installation smoke
   test, including the SDK's Node import and TypeScript checks. Each runner uploads its tested
   platform tarball with a SHA-256 manifest, and linux-x64 also uploads the launcher and SDK
   tarballs. After production, the npm job verifies the full set against those manifests and
   publishes the exact tarballs. It retrieves each platform version from npm before publishing the
   launcher, then publishes the SDK. Newly uploaded platform tarballs must match the tested bytes.
   Recovery checks already-published versions for availability and skips uploading them.

Production publication supports stable versions only, sent to `latest`. The
mandatory production chain retains its existing latest-stable-tag guard, so a
prerelease tag cannot publish through this workflow; it fails closed before
production. Dry-run prerelease packing may still select `next`, but that is not
permission to publish without deployment/smoke. Restoring a separate prerelease
publication policy requires an explicit owner decision, not an automatic gate
bypass. The initial migration commit uses a
`Release-As: 2.0.0` footer to promote v2. Future versions follow conventional commits normally.
Version changes stay in the release PR; do not edit package versions or push release tags by hand
for the normal flow. All root and workspace versions must match the CLI's version.

## npm authentication and the first v2 release

Publishing uses npm Trusted Publishing (GitHub OIDC), not a persistent `NPM_TOKEN`.
Configure each of the six packages to trust GitHub repository `The-Vibe-Company/armada`,
workflow **`release.yml`**, environment **`npm`**. The existing main package already trusts this
workflow. Preserve its settings and its requirement for two-factor authentication.

The four platform packages are new. npm requires a package to exist before a trusted publisher
can be configured. Bootstrap them once using the actual platform tarballs built by the verified
release workflow and an authenticated maintainer session (`npm login`). Publish under `next`
until the complete release is ready; never upload placeholder binaries. Then configure their
trusted publishers with npm's settings or npm 11.10+:

```sh
npm trust github @the-vibe-company/armada-darwin-arm64 \
  --repo The-Vibe-Company/armada --file release.yml --env npm --allow-publish
```

Repeat for the other three platform packages. npm requests the maintainer's 2FA confirmation.
Do not weaken publishing protections or commit credentials. After all platform packages exist,
resume the release to publish the main package using OIDC. Subsequent releases need no npm login.

The SDK package `@the-vibe-company/armada-sdk` is bootstrapped the same way before the first release
that contains it: publish the exact `the-vibe-company-armada-sdk-<version>.tgz` from that release's
`npm-tarballs-<version>-linux-x64` artifact with a maintainer session, then run `npm trust github` for it.
Until then that release's npm job fails after the CLI packages are published; rerunning it after the
bootstrap skips the already-published versions and publishes nothing twice.

For any new npm package, the owner must bootstrap it and configure its trusted publisher
before adding its name to `scripts/release/npm-packages.json`. PR CI compares that list
with the package names staged for release.

After v2 is published and installation succeeds, deprecate **only** the legacy versions:

```sh
npm deprecate '@the-vibe-company/armada@<2.0.0' \
  'Armada v1 is retired. Upgrade with npm install -g @the-vibe-company/armada.'
```

Keep published historical versions available; do not unpublish them or delete users' v1 config.

## Dry runs and recovery

If production Armada cannot launch a repair worker, use the
[break-glass launch runbook](break-glass-launch.md).

`Actions → Release → Run workflow` defaults to a dry run from the selected ref. It builds,
packs and smoke-tests every platform, then runs `npm publish --dry-run`.

To recover a release, dispatch from `main` with the **version** and full **sha**.
The workflow validates the source on main and reruns the release gates. For
published versions, both inputs must match the latest stable tag and its commit.
Recovery uses the executing workflow's tooling and the selected SHA's source.
It skips npm versions already published. See [Tag last](#tag-last).

The `npm-tarballs-<version>-<target>` Actions artifacts contain the exact packed packages and
per-target `SHA256SUMS-<target>` manifests.
Do not rebuild or substitute tarballs during a bootstrap or recovery.

## Installation and migration

```sh
npm install --global @the-vibe-company/armada
armada --version
armada login --url https://armada.thevibecompany.co
```

Installing v2 under the same package replaces the old global `armada` executable. Verify the
new version before removing any separate legacy installation. Authentication state from v1
is not reused by v2; sign in once. See [onboarding](dave-onboarding.md).

### Smoke resources and model accounts

User-facing saved environments are **snapshots**. Existing API/MCP names and
smoke configuration fields such as `golden` and `goldenId` retain their wire
spelling; do not rename them in case JSON. Model accounts are separate from
Boat/Modal provider credentials and Docker host registrations.

Morph is a shared model account for Claude Code, Codex and OpenCode on supported
runtime-backed placements. Its default limit is 2 simultaneous agents per account;
other account kinds default to unlimited. Stopped/idle-paused sandboxes do not
count. Existing account caps also apply to smoke admission: refusal is not a
provider pass, and the runner must not silently choose a different billing
account. Do not raise limits or reset bindings merely to bypass a failed smoke.
For deliberate owner-authorized account configuration, use
`armada creds limits ACCOUNT_UUID --max-agents N` or `--unlimited`, as documented
in [model accounts](named-model-credentials.md).

These are existing product constraints, not new release inputs or a requirement
to add Morph/Boat cases. Retain the owner-enabled Modal/Docker release probes;
Boat remains outside the release gate.

## Deployment policy (#1547)

**Token cutover:** both environments now require their Railway token. Disable
staging Git auto-deploy before the next Actions server upload; never use missing
or invalid credentials as permission to return to Git deployment.

Main pushes start **Release**, whose completion wakes **Pinned staging smoke**: migrate staging → deploy pinned server
→ wait for that Railway deployment and public version health → build dashboard
in Actions → upload prebuilt output → sandbox smoke. There is one staging writer,
not an independent migration job plus provider-triggered deployments. No PR,
merge-queue or release-please branch deployment triggers smoke. The main-only
manual **Post-deploy smoke** entry point calls the same deploy/smoke workflow,
using its selected main SHA; it is not a deployment-status subscriber.

Production deploys **only through a publishing Release**. The Release workflow
requires successful `check`, binaries and exact-source staging smoke before it
promotes the image and creates the tag and GitHub release. Production migrations,
server, prebuilt dashboard and npm follow in that order. A failed `check` blocks
publication even if staging has already deployed and smoked that SHA.
A dry-run release never enters staging/production deployment or publishes npm.
There is no variable to bypass the gate: RELEASE_SYNCED_DEPLOYS and
STAGING_GATED_DEPLOYS are obsolete and ignored. Missing configuration fails,
never falls back to Git auto-deploy or a successful no-op smoke. Production
publication cannot proceed after a skipped/failed/cancelled publishing deploy.

Both dashboard projects use `apps/dashboard/vercel.json` with
`git.deploymentEnabled: false`. Vercel documents false for all branches in its
[Git configuration reference](https://vercel.com/docs/project-configuration/git-configuration#turning-off-all-automatic-deployments).
Both project Root Directories must be apps/dashboard with workspace inclusion.
Node 24, repository-pinned Bun and Vercel CLI 65.14.0 run `vercel pull` with
production environment selection, `vercel build --prod`, and
`vercel deploy --prebuilt --prod`. For staging, --prod targets the separate
staging project's domain, not Armada production. Token authentication uses the
environment, never argv. Clean source archives remain pinned to the validated
SHA; deployment tooling comes from the executing workflow revision for recovery.
Both projects use Actions for dashboard builds and deploy only prebuilt output.
PRs do not get dashboard previews. Provider-side settings and cutover evidence
are tracked in the deployment policy acceptance ledger below.

Pulled settings/env and generated artifacts live only in disposable runner files,
not the repository. See [Vercel's Actions guide](https://vercel.com/kb/guide/how-can-i-use-github-actions-with-vercel).

### Fail-fast release configuration

Before a publishing run can announce/tag a GitHub release, upload an image,
publish npm or deploy a host, the first step of each staging/production
configuration job checks the names below. A missing value fails with one line:
`Missing release configuration (<environment>): <missing names>`; values are
never printed. Both environment checks must succeed. Production rechecks at its
own first step, before checkout or mutation, in case configuration changed later.

The intent job uses GitHub metadata and loads no deployment credentials. For
automatic main runs, HTTP 200 permits version PR preparation and HTTP 404
admits a candidate after it verifies the merged version PR. Both candidate
publication and explicit recovery require the environment checks. API and
transport errors fail closed. Release Please always skips GitHub release
creation. Dry runs skip staging and production configuration.

Environment approvals/protections still apply, potentially earlier in a release.
Presence is not credential validity, network connectivity or scope verification.
Do not remove/rotate required configuration mid-release: later changes can still
fail after an earlier stage published, so the existing partial-recovery rules
remain necessary. No PR CI jobs or required checks are added by this workflow.

### Owner cutover prerequisites (no agent performs these operations)

Before merging the default-policy switch, freeze merges and drain active release,
migration and provider deployment writers. Confirm the earlier staging Actions
path built/uploaded a Ready deployment with matching githubCommitSha, working
staging domain and login. Keep known-good Railway IDs/Vercel URLs/source SHAs and
review database history/backups with the operator. Preparing stacked PRs does not
waive deployed proof; local checks do not prove provider settings or credentials.

1. GitHub Environments: allow **main and version tags v*** on staging/production,
   deny arbitrary branches, restrict dispatch and environment settings to owners.
   Keep existing npm OIDC protections and optional production approvals. No new
   required PR check: Lint, typecheck and test remains under two minutes. The
   only slow gated path is publishing release → staging smoke → production.
2. Populate the existing environment secrets below in **each** matching environment
   with its own project/service IDs. Keep staging variable ARMADA_ORIGIN and
   secrets ARMADA_SMOKE_TOKEN/ARMADA_SMOKE_CASES covering enabled pairs; the
   smoke origin must equal ARMADA_SERVER_URL. See [smoke setup](post-deploy-smoke.md).
   Preserve Vercel production-environment build variables including public Supabase
   values. No credential is supplied through dispatch or logged.
3. Railway administrator: in the **production server service** and **staging
   server service**, disable GitHub branch auto-deploy (disconnect the GitHub
   source if necessary). Leave the service, domain and runtime variables intact,
   root directory /, repository-root Dockerfile and /healthz checks enabled.
   Existing project tokens must be scoped to their matching environment. CLI
   uploads become the only deploy writer. Delete/disable independent deploy hooks
   or other automation that can promote main outside the serialized Actions path.
4. Vercel owner: verify both projects use Root Directory apps/dashboard and
   **Include source files outside of the Root Directory in the Build Step**.
   Ensure old active branches incorporate the config; source-local disablement
   does not rewrite old branches. For a project-wide cutoff or lingering checks,
   disconnect the repo on **each project → Settings → Git → Connected Git
   Repository → Disconnect** per the [official guide](https://vercel.com/docs/project-configuration/git-settings#disconnect-your-git-repository).
   Keep domains/project IDs/build/runtime vars; explicit CLI paths stay available.
   Remove obsolete Vercel/Post-deploy smoke required checks in GitHub rules,
   never Armada's fast verdict. Historical checks are not erased by a commit.
5. No opt-in variables need enabling. Dispatch main's pinned staging workflow
   under the freeze, confirm staging proof, then use an owner-reviewed release.
   Do not restore legacy production Git deployment or standalone SQL apply.

### Release configuration names

Names only; resolve each from its matching environment or authorized inherited
scope. Never paste values into logs, argv, issues, dispatch inputs or repo files.

| Name | GitHub environments |
| --- | --- |
| `SUPABASE_ACCESS_TOKEN` | staging + production |
| `SUPABASE_DB_PASSWORD` | staging + production |
| `SUPABASE_PROJECT_ID` | staging + production |
| `RAILWAY_TOKEN` | staging + production |
| `RAILWAY_PROJECT_ID` | staging + production |
| `RAILWAY_ENVIRONMENT_ID` | staging + production |
| `RAILWAY_SERVICE_ID` | staging + production |
| `VERCEL_TOKEN` | staging + production |
| `VERCEL_ORG_ID` | staging + production |
| `VERCEL_PROJECT_ID` | staging + production |
| `ARMADA_SERVER_URL` | staging + production |
| `ARMADA_SMOKE_TOKEN` | staging |
| `ARMADA_SMOKE_CASES` | staging |
| `ARMADA_ORIGIN` | staging **variable**, not a secret |

Use distinct matching-environment Railway tokens; staging ARMADA_ORIGIN must
match ARMADA_SERVER_URL. Existing server runtime/model secrets and npm OIDC
configuration remain intact; this is workflow configuration, not a request to
recreate runtime credentials. GITHUB_TOKEN is automatically supplied by GitHub;
RELEASE_SHA/RELEASE_VERSION are workflow outputs, not owner-managed secrets.


### Ordering, failures, recovery and deployed proof

Railway CLI 5.71.0 uploads clean pinned source, then the workflow waits for the
**exact returned deployment ID** to reach SUCCESS and public /healthz to report
both the source version and full release SHA. The clean upload archive carries
`packages/mcp-server/src/source-identity.json`, bundled into the server binary;
this identity takes precedence over provider Git metadata. Missing or wrong
commit evidence (including a same-version older server) fails closed. Only then does it build/upload the dashboard. Vercel waits
for Ready. npm only follows successful production for publishing releases.
No deploy hook or moving main checkout substitutes for the validated source.

Steady-state releases do **not** require a merge freeze: continue merging green
PRs while the release owns staging. See the [merge queue operating policy and
acceptance evidence](merge-queue.md#releases-do-not-freeze-merges-1850). The
one-time provider cutover freeze above is separate.

Ordinary main workflows retain only the latest pending main without cancelling
active work. Release holds the shared `release-production` admission lock for its
whole lifetime; ordinary staging jobs acquire that same lock. Pinned child smoke
uses a distinct lock to avoid reacquiring its parent's reservation. The shared
lock is the only admission authority: an ordinary job that acquires it
proceeds, regardless of stale queued Release rows in the Actions API. Already
admitted deployments finish safely. Preparation and dry runs briefly serialize on
the lock too, but do not create a separate reservation or read production configuration.

A `workflow_run` completion wakeup (success, failure or cancellation) is the
sole automatic ordinary staging trigger. The wakeup resolves current main
after acquiring the shared lock. The deploy step rechecks the SHA before
mutation. Repeated wakeups share the latest-main group. A wakeup coalesces
when a trusted ordinary run successfully deployed and smoked the checked-out
SHA after the triggering Release finished and staging health still identifies
it as live. This protects recovery when a newer completion supersedes the
wakeup from a failed or cancelled Release. This includes existing push runs
during the transition. Coalescing reports a neutral summary. Unavailable or
ambiguous evidence falls back to deployment. Pinned release calls always require
fresh exact-schema acceptance and never use this optimization.
Manual workflow_dispatch uses the same lock and proceeds too. Waiting admission
is visibly queued in Actions, never a green deployment with every mutation skipped.
There is no manual merge pause. API or main-resolution failure
fails closed. Schema-changing merges flow normally; their staging migrations wait
until the release relinquishes its reservation. Never cancel live smoke blindly.
Completion journals carry the triggering Release run ID. The shared ordinary and
pinned receipt consumer authenticates the producer repository, branch and workflow,
then fetches that Release and requires trusted repository/branch, Release workflow,
push/manual event and completed status. Missing or invalid provenance fails closed;
cleanup receipts are preserved rather than discarded. A cancelled Release therefore
still wakes newest main; a later active Release can defer it again. Continuous
queued releases do not guarantee ordinary staging progress.

Already-running old workflow revisions are not changed by this source update.

Owner proof: updated PR/queue/release-please deployment events create no smoke
workflow; ordinary main updates staging but not production or npm; a publishing
release uses its exact SHA for staging and production; failed/cancelled/skipped
release smoke blocks production/npm. Compare Actions source SHA, Railway message,
Vercel githubCommitSha, public server/dashboard version and deployment histories.
Record the actual results; a procedure is not proof. Do not intentionally fail
production. Only use staging fault cases under owner authorization.

Services do not provide an atomic transaction. If dashboard fails after server
or migrations succeeded, those changes remain applied; npm can fail after hosts
succeed. Keep migrations additive/backward-compatible. Never auto-undo SQL,
reset databases, unpublish npm or automatically roll back hosts. A timeout may
leave a remote deployment running: owner inspects/drains before recovery.

Recover via **Release → Run workflow** on main with the version and full source
SHA. For a published release, use the exact latest stable tag's SHA. Already
recorded migrations and published npm versions are skipped. Cut a forward
hotfix for a superseded version.
Older tags can still fail staging on unknown or non-forward migration history;
never repair history to force them through. Known forward main history is handled
by the staging-only check described below. A failed smoke has no variable-based emergency bypass.
Owner incident rollback requires schema-compatible known-good host deployments
and recorded approval; prefer a new reviewed forward fix/revert release.
Production history/confirmed repair and dry-run remain explicit manual operator
tools, not a release authorization or application SQL apply path.

### iOS TestFlight

TestFlight remains independent: main pushes changing apps/ios (or manual main
dispatch) verify, archive and upload to the Armada Internal tester group, using
the testflight environment. It neither triggers nor authorizes server/dashboard
production, migrations or npm and is not a release dependency. Its existing
APP_STORE_CONNECT_API_* and IOS_DISTRIBUTION_CERTIFICATE_* secrets remain in that
environment (see apps/ios/README.md); no new iOS credentials/settings are required.
Changing TestFlight's beta cadence or coupling its app binary to release tags is
outside this small deployment-gate PR.


## Railway token cutover (#1547)

The owner supplied RAILWAY_TOKEN in staging and production. The interim
staging-only no-token Git-wait path is retired. Both environments now require
Railway tokens/IDs before any migration or provider mutation. A missing token is
an immediate named configuration error; a present but invalid token, wrong IDs
or failed upload fails the CLI path. None falls back to Git. The public health
commit field remains useful deployment identity, not fallback authorization.

Before the next Actions server deployment, the Railway owner must select the
**staging** environment → server service → Settings → Source / Service Source →
connected repository/main trigger → **Disable** automatic deployments. Confirm
Enable is offered / deploymentTriggers is empty for staging. Keep the active
service, domain, runtime variables, root Dockerfile and healthcheck intact.
Inspect/drain already queued Git deployments and current Actions work so an old
Git writer cannot replace the Actions result; do not blindly cancel live smoke.
Production's owner-verified disabled Git trigger must remain off too.

Token presence is not an authentication/scope check. Perform one owner-authorized
pinned staging Actions upload with no parallel Git deployment; verify the returned
Railway deployment ID reaches SUCCESS, public health/version, source message and
Ready dashboard and the remaining non-Boat release-gate smoke. Only after the exclusive
writer is proven should normal merges resume. If credentials are wrong, fix
configuration; never re-enable Git as a fallback or restore production following
main without its release migrations. No agent performs provider changes or deploys.

The canonical [release configuration list](#release-configuration-names) above
applies to both environments. No tokenless exception remains.

## Deployment policy acceptance ledger (#1547)

The repository implementation is present; issue closure still requires the
coordinator's provider-side evidence. Merged code and a green PR verdict do not
prove that a provider's independent Git writer is disabled. Do not interpret
this ledger as a deployment receipt or permission to deploy.

| Acceptance criterion | Repository implementation | Outstanding owner evidence |
| --- | --- | --- |
| No Vercel builds or PR previews | `apps/dashboard/vercel.json` disables Git deployments; the shared deployment script runs `vercel pull`, `vercel build`, then `vercel deploy --prebuilt` in Actions | Compare both Vercel projects' deployment lists before/after a new PR push; confirm no new deployment or Vercel check |
| Staging follows main | `staging-gated-production.yml` handles main pushes; queued ordinary sources are superseded before mutation; active work finishes | Confirm staging Railway Git is disabled and old queued writers are drained, then record one main SHA, Actions run, Railway deployment ID, dashboard Ready deployment and Modal/Docker smoke receipts |
| Production only follows releases | `release.yml` requires exact-release staging smoke before protected production; the deployment script applies migrations before server upload and uploads a prebuilt dashboard | Confirm production Git and other independent writers remain disabled; compare production deployment history across an ordinary main push and an authorized publishing release |
| Fast PR verdict is unchanged | Builds and provider smoke stay in post-merge/release workflows, not PR checks | Record the latest PR aggregate verdict and elapsed time; no new required check is introduced |

Existing recovery/cutover comments on #1547 are historical context, not fresh
proof for another environment or deployment. Attach actual non-secret IDs,
source SHAs and results to the issue when the coordinator performs these checks.
Until then, report provider acceptance as **not verified**, not passed. No agent
should trigger a release, change provider settings or apply SQL to fill this
ledger. Follow the owner cutover and recovery procedures above.

## Railway IaC cutover (#1918)

Server settings now live in [.railway/railway.ts](../.railway/railway.ts), not
railway.json. **Before the next publishing release**, the Railway owner must
complete the [staging-first cutover checklist](../.railway/README.md) for both
environments. `railway up` uploads source but does not apply IaC. Actions order,
CLI pin and disabled Git autodeploy remain unchanged. Code and unit CI do not
establish that the live environments have been migrated.

## Exact-release migration inventory (#2394)

Pinned release staging rejects any remote migration outside the release inventory,
even if it belongs to newer main. Pending release migrations still apply normally.
Production keeps its existing exact-source SQL path. Ordinary staging retains the
known-forward-history check for its own deployment/recovery behavior. No history
repair, rollback or newer-main SQL is allowed to make release staging pass.

Deferring ordinary staging for the whole release prevents newly merged migrations
from entering staging between its pinned smoke and production. If staging was
already ahead before the reservation, the release fails closed; recover with a
forward release containing that history. This policy compares immutable migration
versions, not arbitrary database objects or untracked manual SQL drift. The owner
must keep independent database/provider writers disabled.

### Exact-commit staging evidence

Pinned release calls always deploy and smoke directly under the reservation.
Historical ordinary staging evidence cannot authorize the new exact-inventory
policy: a successful old run may have accepted newer SQL under the former
forward-history exception. Official-image releases also require the generated pin
from their calling release. No historical smoke success bypasses this check.

### Docker normal-launch production prerequisite check

Before accepting Docker launch after a release, compare production with the
[normal-launch diagnostic checklist](docker-host-daemon.md#diagnosing-an-immediate-normal-launch-refusal-2239):
Docker flags, matching architecture manifest/artifacts and release image pin,
public HTTPS runtime enrolment/WebSocket reachability, encryption/model accounts,
and membership/actor-epoch/default-resource rows in the production org.
Staging's smoke org, registration and preview image do not seed production.
An online host with placement enabled is not runtime readiness. For #2239 the
specific missing production dependency remains unverified without the new
phase-coded refusal; the coordinator must capture that reason and re-run the
owner's normal launch after release. Do not infer a production pass from CI.

## Release latency investigation (#2394)

Baseline: [release 43817524703](https://github.com/The-Vibe-Company/armada/actions/runs/43817524703)
(2026-11-16, 2.46.4), from the Actions jobs/steps API and timestamped logs:

| Phase | Elapsed |
| --- | ---: |
| Release checks | 6m 23s |
| Official image | 1m 46s |
| Slowest binary runner | 2m 12s |
| Staging admission after configuration | 45s |
| Staging job setup through client installation | 26s |
| Migrations, server and dashboard | 3m 38s |
| Dependencies and journal restoration | 2s |
| Smoke (including cleanup) | 13m 49s |
| Production | 4m 31s |
| npm | 9m 28s |

Within smoke, logs place the clean lifecycle at 121405ms and the preservation
lifecycle at 47925ms. The final journal cleanup runs from approximately 06:56:07
to 07:03:07 UTC (7m). Repeated `sandbox_not_ready` delete acknowledgements dominate
that interval. This is not evidence of redundant golden creation. Cleanup already
runs independent receipts concurrently in two authority-ordered waves; do not
parallelize delegated children with their parent fence or drop cleanup coverage.

Probe receipts now include individual `elapsedMs` for default-skill reads, vault,
templates, expiry and lifecycle steps, including failed steps. These durations
measure actions directly, not gaps between unrelated interleaved log lines. No
credentials, action return values or error messages are added to logs.

Current source already uses `queue: max` on `release-production` and the shared
staging job lock; pinned staging calls have run-specific outer groups. The
cancelled [2.46.2 run](https://github.com/The-Vibe-Company/armada/actions/runs/43799989064)
is historical evidence of cancellation, not sufficient evidence that today's
FIFO configuration still evicts releases. Confirm the cancellation reason and
executing workflow revision before replacing these controls.

### #2394 acceptance ledger (repository work and outstanding evidence)

| Criterion | Evidence / outstanding work |
| --- | --- |
| Merge-safe pinned release | Whole-release staging reservation, early ordinary admission yield and completion wakeup implemented; coordinator must record a release concurrent with ordinary main and schema-changing merges |
| Exact production SQL equals smoked SQL | Pinned release staging rejects forward history; ordinary migrations defer for the entire release. Coordinator must compare smoked and production immutable migration inventories; no deployed proof claimed |
| Faster Modal/Docker probes, no lost coverage | Baseline measured above; current ordinary smoke validates Modal cases only. Full parity provider scheduling landed in #2406. Existing release smoke remains Modal-only; parity gate wiring and authenticated same-commit golden reuse remain outstanding |
| Before/after timings | Baseline above; per-step instrumentation implemented. Coordinator must collect an authorized post-merge staging run; no after measurement or speedup is claimed |

No new configuration, CI job, required check or deployment prerequisite is added
by timing instrumentation. Boat remains outside the release gate. This ledger
must not be read as release-path acceptance or permission to deploy.

The owner decision “Différer staging” (2026-11-16) supersedes FIFO fairness for
ordinary queued staging. The reported 2.49.1 delay (pinned smoke pending after
13:10Z behind ordinary smoke begun at 13:00Z, issue comment) is consistent with
the shared job lock, not proof of pending replacement under current `queue: max`.
The workflow source reserved staging only during the smoke job, leaving the rest
of a release exposed to ordinary staging/schema writes; the whole-release lock
addresses that cause. No new required PR check or provider setting is added.

This repository change does not close #2394: gate wiring, any proven duplicate
golden work and authorized before/after runtime evidence remain outstanding.
The current smoke entrypoints launch authenticated existing goldens rather than
building them; no duplicate build was found to remove. Do not infer a same-commit
golden cache hit from a golden name or a successful historical smoke alone.

## Tag last

The release sequence follows the design in [#2838](https://github.com/The-Vibe-Company/armada/issues/2838).

1. **Prepare the version PR.** Always set `skip-github-release: true`.
   The [pinned action](https://github.com/googleapis/release-please-action/blob/5c625bfb5d1ff62eadeeb3772007f7f66fdcf071/src/index.ts#L136-L151)
   leaves PR creation enabled and stops emitting `release_created` and
   `tag_name`. Publication intent supplies `version`, `sha` and `mode` (prepare, candidate or recover) to
   `release-metadata`, replacing its Release Please inputs and tag-first guard.
   Keep workspace-version validation there. Checks, builds and smoke use
   the validated SHA and retain their parallel ordering. Candidate mode can
   publish only after checks, binaries and exact-source smoke succeed.
   Recover mode uses the verified published SHA and digest. Prepare mode
   may reconcile labels and run Release Please without entering deployment
   environments. Production requires verified publication and successful
   smoke for the selected SHA.
2. **Freeze the candidate SHA at admission.** For an automatic run, use the
   current main head under the release lock, provided it still carries the
   triggering version and contains that version PR's merge commit. A same-version
   fix-forward retry can therefore include fixes merged since the version PR.
   Checks, binaries, image, smoke and production all use this same source and
   pin. The version PR's changelog ends at its original cutoff. Generate a
   compare link and include intervening changes from the version PR merge to
   the selected SHA in the GitHub release notes. Release Please bases the next
   changelog on commits after the actual tag. Its
   [release reader](https://github.com/googleapis/release-please/blob/891bcf6253b390e39df9ff3e1c059a836bd39c98/src/github.ts#L848-L925)
   supplies the tag's commit SHA to the
   [commit scan](https://github.com/googleapis/release-please/blob/891bcf6253b390e39df9ff3e1c059a836bd39c98/src/manifest.ts#L541-L675).
3. **Build and smoke before publishing.** Push the sandbox image as
   `:<version>-rc.<sha7>`. Carry the full SHA and immutable registry digest
   in workflow evidence. The binaries embed `<registry>@sha256:<digest>` via
   `official-sandbox-image.json`, and staging smokes that pin. After the smoke
   passes, promote from the tested digest with
   `docker buildx imagetools create --prefer-index=false -t "<registry>:<version>" "<registry>@<digest>"`.
   Resolve the stable image tag and require the same digest before publishing.
   Docker [copies an index](https://docs.docker.com/reference/cli/docker/buildx/imagetools/create/)
   unchanged when given a single index source. The flag also preserves the
   single-manifest format. Promotion leaves the embedded binary pin intact.
4. **Publish and reconcile the labels.** Create the GitHub release with
   `gh release create "v<version>" --target "<sha>" --notes-file "<notes>"`
   as the final publication step before production. A failed smoke leaves the
   version and stable image unpublished. A failure between image promotion and
   release creation can leave a stable image. Until release creation, only a
   candidate with fresh successful smoke may reconcile it. Once the release
   exists, verify the peeled tag commit and stable image digest on recovery.
   `--target` only sets the commit when the tag is missing, so check any
   existing tag explicitly and reject conflicts.
   [GitHub CLI release creation](https://cli.github.com/manual/gh_release_create)

   After verifying the release, the publishing job adds `autorelease: tagged`
   and removes `autorelease: pending` on the original version PR. Do this
   idempotently in that order. Release Please's
   [PR builder](https://github.com/googleapis/release-please/blob/891bcf6253b390e39df9ff3e1c059a836bd39c98/src/manifest.ts#L920-L939)
   blocks while a merged release PR carries the pending label, even when a
   release exists. With release creation disabled, the publishing job owns
   [the label change](https://github.com/googleapis/release-please/blob/891bcf6253b390e39df9ff3e1c059a836bd39c98/src/manifest.ts#L1294-L1316).
   On a published-version main push or recovery, reconcile before invoking
   Release Please: resolve the original merged version PR from the version
   change, verify the published tag contains its merge commit, then add and
   remove the labels with the GitHub issue-label API. Already-correct labels
   are success. If identity or the update cannot be verified, stop before
   PR preparation so a later admission can repair it. Keep npm downstream
   of production.

### Admission and recovery

Every main push can enqueue a Release run. The workflow-level
[`release-production` group](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
with `queue: max` serializes runs and allows up to 100 pending. Each run reads
release-by-tag **after admission**, so queued pushes do not all act on the
same 404. A 404 for the current version with a matching merged version PR
allows a candidate. A 200 allows ordinary PR preparation and verified label
reconciliation. Other API responses fail closed. After the SHA is frozen, a
same-version main advance alone does not invalidate a passing candidate.
Before publication, require the candidate version on main and reject a newer
stable tag. After publication, production and recovery require the latest stable
version and its exact tag SHA.

Dispatch the **Release** workflow from main with `version` and a full commit
`sha` to retry a release with fixed workflow tooling:
`gh workflow run release.yml --ref main -f version=<version> -f sha=<full-sha>`.
[Actions dispatch](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow#running-a-workflow)
selects the workflow ref independently of its input values. Validate the SHA
belongs to main, contains the matching version PR merge and has that version
in source. Use the selected SHA for source and builds. Continue the existing
[workflow-revision checkout for recovery tooling](../.github/workflows/release.yml#L541-L546)
so a tooling fix on main can recover an older source SHA. Before publication,
repeat validation and exact-source smoke for the selected SHA. If a tag
exists without a release, require that exact SHA and smoke it again before
creating the release. If the release already exists, both inputs must match
the latest stable tag and its peeled commit. Reuse its published image digest,
repair any interrupted label update and retry the protected downstream steps.
A different SHA after publication requires a new version.

### Tag-last acceptance ledger (#2839)

| Criterion | Evidence to record |
| --- | --- |
| Failed smoke leaves no stable publication | Scratch workflow run with a failing smoke and before/after checks of the tag, GitHub release and stable image |
| First real tag-last release | Actions timeline showing smoke completed before image promotion and tag/release creation, followed by the existing production and npm jobs |
| First-try reliability | Coordinator tracks the next ten releases against the 90% first-try green target |
