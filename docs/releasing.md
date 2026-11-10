# Releasing the CLI to npm

Armada v2 replaces v1 under the existing public package `@the-vibe-company/armada`.
Keep that package name: existing users upgrade with `npm install -g @the-vibe-company/armada`.
The v2 launcher selects one of four optional platform packages, `@the-vibe-company/armada-{linux,darwin}-{x64,arm64}`.
The workspace packages stay private; the compiled binaries bundle their dependencies.

## Normal releases

1. Merge conventional commits (`feat`, `fix`, breaking changes) into `main`.
2. The Release workflow runs Release Please and opens or updates `chore(release): <version>`.
   It updates the root package, every workspace package, the changelog and the release manifest.
   The workflow also synchronizes Bun's lockfile and explicitly dispatches CI on that PR's branch.
   This explicit dispatch matters: PRs and pushes created with `GITHUB_TOKEN` do not trigger ordinary CI.
3. Review the version PR and merge it after all checks pass. Release Please creates `v<version>` and
   the GitHub release, then the **same workflow** validates, builds and publishes it. It does not
   rely on a tag-push event from the bot token.
4. Four native runners compile and smoke-test the binaries. The publisher stages and packs the
   five npm packages, saves their tarballs and SHA-256 checksums as an Actions artifact, runs the
   installation smoke test, and publishes platform packages before the main package.
   `scripts/publish-npm.sh` then retrieves each exact platform version from npm before publishing
   the launcher. Newly uploaded tarballs must match the staged bytes; existing immutable versions
   are checked for availability without requiring a rebuild to be byte-identical. Registry retries
   share a five-minute budget (`NPM_PUBLISH_WAIT_SECONDS`, poll interval `NPM_PUBLISH_POLL_SECONDS`).

Stable versions go to `latest`; prereleases go to `next`. The initial migration commit uses a
`Release-As: 2.0.0` footer to promote v2. Future versions follow conventional commits normally.
Version changes stay in the release PR; do not edit package versions or push release tags by hand
for the normal flow. All root and workspace versions must match the CLI's version.

## npm authentication and the first v2 release

Publishing uses npm Trusted Publishing (GitHub OIDC), not a persistent `NPM_TOKEN`.
Configure each of the five packages to trust GitHub repository `The-Vibe-Company/armada`,
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

After v2 is published and installation succeeds, deprecate **only** the legacy versions:

```sh
npm deprecate '@the-vibe-company/armada@<2.0.0' \
  'Armada v1 is retired. Upgrade with npm install -g @the-vibe-company/armada.'
```

Keep published historical versions available; do not unpublish them or delete users' v1 config.

## Dry runs and recovery

`Actions → Release → Run workflow` defaults to a dry run from the selected ref. It builds,
packs and smoke-tests every platform, then runs `npm publish --dry-run`.

To recover a partially published release, run the workflow from `main` with the existing
`v<version>` tag in **tag** and **publish** enabled. It validates the exact tag, requires it to
belong to `main`, and pins all builds to that commit. Existing package versions are skipped;
missing versions are published. Publication tooling is loaded from the executing workflow's
revision so tags predating the registry guard can still be recovered; all package artifacts remain
pinned to the selected release tag. A run without an existing version tag cannot publish.

The `npm-tarballs-<version>` Actions artifact contains the exact packed packages and `SHA256SUMS`.
Do not rebuild or substitute tarballs during a bootstrap or recovery.

## Installation and migration

```sh
npm install --global @the-vibe-company/armada
armada --version
armada login --url armada.thevibecompany.co
```

Installing v2 under the same package replaces the old global `armada` executable. Verify the
new version before removing any separate legacy installation. Authentication state from v1
is not reused by v2; sign in once. See [onboarding](dave-onboarding.md).

## Release-synchronized production (owner opt-in)

**Merging this change alone does not change production.** Until the repository
Actions variable `RELEASE_SYNCED_DEPLOYS` is exactly `true`, Railway/Vercel Git
autodeploy and the existing push-to-main migration job retain their behavior.
Do not enable the variable before completing the cutover below. PR previews are
not changed by these workflows.

With opt-in enabled, a publishing release waits for validation and all four
binary builds, then runs **Release migrations, server and dashboard**, then npm
publication. All artifacts and both source uploads use the validated tag's full
commit SHA, not the moving tip of `main`. Deploy tooling comes from the executing
workflow revision so tagged recovery also works for older source tags. Ordinary
merges only prepare the next Release Please PR; they no longer apply migrations.
Dry-run releases never access the production environment. Prereleases can still
be packed/published in legacy mode; the opt-in production chain deliberately
accepts only the latest stable `vX.Y.Z` tag, preventing stale-tag redeployment.
A newer tag supersedes recovery of an older tag; recover the newest release or
make a forward hotfix instead.

### Owner cutover checklist (no agent performs these operations)

Schedule a short release freeze; do not merge migration/application changes
while switching settings. Wait for in-flight release, migration and host deploys
to finish. Keep the previous successful deployment IDs for incident recovery.

1. In GitHub, use the existing **production** environment (environment names are
   case-insensitive; do not make a second `Production` environment). Allow the
   `main` branch **and** version tags (`v*`) in its deployment branch/tag rules;
   keep arbitrary branches denied. Use required reviewers if desired. Restrict
   workflow dispatch and environment configuration to release owners. Keep the
   separate `npm` environment and its OIDC trusted-publisher settings unchanged.
2. Add the exact environment secrets below. No credential belongs in dispatch
   inputs, the repository, or a deploy hook URL. Missing values fail explicitly
   before the first production mutation. Invalid credentials/settings fail the
   corresponding provider command; preflight does not claim to validate access.
3. Railway: on the existing production server service, disable automatic GitHub
   deployments from `main` (disconnect its GitHub source if necessary); leave
   the service, domain and runtime variables intact. Keep deployment health
   checks enabled at `/healthz` using `railway.json`, Dockerfile at repository
   root, and root directory `/`. Ensure the project token is scoped to the
   production environment and the service ID is the server, not another service.
   CLI source uploads replace GitHub autodeploy as the production release path.
4. Vercel: keep the Git integration for PR previews. Set the production branch to
   an owner-protected, non-developing branch such as `production-disabled` (create
   it once from `main`, never push/merge to it, and deny developer pushes).
   Thus ordinary `main` merges cannot promote production. Do **not** disable the
   whole Git integration or set an ignored-build command that also blocks PRs.
   Keep Root Directory **apps/dashboard**, enable **Include source files outside
   of the Root Directory in the Build Step**, and retain production build/runtime
   environment variables. The CLI uploads the repo root and targets the existing
   project via its IDs; it does not create a project or deploy only the app folder.
5. Set repository Actions variable **`RELEASE_SYNCED_DEPLOYS=true`** last. Keep
   the variable at repository scope, not environment scope (job conditions must
   see it before entering an environment). Lift the release freeze. Use the next
   normal release, or dispatch the latest existing stable tag with `publish=true`
   after reviewing its migration plan and source. No deployment is needed merely
   to review/merge this PR. Verify a PR still receives its Vercel preview.

| production environment secret | Required value |
| --- | --- |
| `SUPABASE_ACCESS_TOKEN` | Authorized Supabase personal access token (existing) |
| `SUPABASE_PROJECT_ID` | Production project reference (existing) |
| `SUPABASE_DB_PASSWORD` | Production database password (existing) |
| `RAILWAY_TOKEN` | Railway project token scoped to the production environment |
| `RAILWAY_PROJECT_ID` | Existing Railway project ID |
| `RAILWAY_ENVIRONMENT_ID` | Existing production environment ID |
| `RAILWAY_SERVICE_ID` | Existing armada-server service ID |
| `ARMADA_SERVER_URL` | Public HTTPS origin of that server, without `/healthz` |
| `VERCEL_TOKEN` | Release owner's Vercel token authorized for this project/team |
| `VERCEL_ORG_ID` | Existing Vercel team/account ID |
| `VERCEL_PROJECT_ID` | Existing dashboard project ID |

No deploy hooks are used: hooks commonly deploy the latest branch tip rather
than the validated release SHA. The pinned clients are Railway CLI 5.71.0 and
Vercel CLI 65.14.0; deployment semantics are documented in the official
[Railway upload](https://docs.railway.com/cli/up),
[Railway deployment list](https://docs.railway.com/cli/deployment) and
[Vercel deploy](https://vercel.com/docs/cli/deploy) references.

### Ordering, failures and recovery

The production job first checks all required configuration, then applies only
pending tagged migrations (forward-only), uploads the tagged server, polls the
**exact returned Railway deployment ID** until `SUCCESS`, and checks that the
public `/healthz` reports the tagged version. Only then does it upload/build the
dashboard with `vercel deploy --prod`, which waits for Ready before success.
Only after both hosts succeed can npm publish. The server health version,
dashboard landing's version badge and `armada --version` all use the same core
package version; compare them after the release finishes.

The opted-in release workflow is globally serialized through npm publication,
with cancellation off and queue: max retaining existing pending runs in FIFO
order (up to 100 pending). New arrivals at capacity are rejected; drain the queue
and retry a rejected run. The production job also shares the legacy migration
lock; do not run manual migrations/history/repair/preview or provider deployments
during a release. Check the intended release run completed before declaring success.

A failure fails Actions loudly and stops later stages. **These independent
services cannot provide an atomic transaction or guarantee rollback of already
successful stages.** Railway keeps the previous server when its new deployment
fails health checks; a failed Vercel build does not promote its domains. But if
Vercel fails after Railway succeeds, the server is already new; if npm fails,
the hosts are already new. Applied migrations also remain applied, and a
multi-statement SQL migration may have partial effects. Therefore every release
must use additive/backward-compatible migrations and tolerate a temporary mixed
version window. Never automatically undo SQL, reset production, or unpublish npm.

Recover via **Release → Run workflow**, ref **main**, exact latest stable `tag`,
`publish=true`. This retries the whole chain from that SHA; already recorded
migrations and already published npm versions are skipped. Inspect a failed
migration's partial effects before retrying. Fix an unapplied migration only
after review; never edit applied migrations. History/repair remains an explicit
operator-only operation in Database migrations. A production job timeout may
leave a remote deploy in progress: inspect/wait for it before recovery.

For a hotfix, merge a conventional `fix:` PR into `main`, expedite and merge its
Release Please version PR after checks pass, then let this same chain release
the new tag. Do not push mutable production branches, retag, deploy untagged code,
or cherry-pick directly into hosts. If earlier stages already succeeded, prefer
this forward fix; an emergency host rollback is an owner incident action only
with a verified schema-compatible prior release. To abandon cutover, freeze
changes, finish/stop in-flight work, disable the repository variable and restore
the original host autodeploy settings together; changing only one risks drift.

## Staging-gated releases (owner opt-in)

**Production is release-only, not per-merge.** Set both repository Actions variables
**RELEASE_SYNCED_DEPLOYS=true** and **STAGING_GATED_DEPLOYS=true** after the owner
cutover below. With neither set, existing behavior remains unchanged and the new
staging workflow emits a disabled notice. Release-sync alone retains #714's
release-only deployment behavior without the new smoke gate. The staging gate
without release-sync is invalid and fails explicitly before deployment/publication.

### Investigation and design

Railway/Vercel Git deployments, independent migrations and deployment-event smoke
do not form a production gate. Generic CI or hooks building moving main cannot bind
a smoke to the promoted source. The #714 release uploader is reusable: it archives
one validated SHA, waits for its Railway deployment ID and health, then uploads the
same source to Vercel. This promotes the **same commit**, not the same image; builds
use environment-specific settings.

- Main pushes continuously run **Pinned staging smoke**: staging migrations →
  staging server → staging dashboard → sandbox smoke, all from the triggering SHA.
- A release (Release Please release creation, version tag push or existing tagged
  recovery) validates its tag/SHA and binaries, then **calls the same staging
  workflow with that exact validated SHA**. Only that successful dependency admits
  production migrations → server → dashboard → npm. A skipped/no-op smoke cannot
  authorize production. Ordinary main merges never enter production or publish npm.
- Release re-smokes rather than trusting a historical check name, mutable branch,
  latest deployment or cached attestation. This also covers tags created by
  GITHUB_TOKEN (which do not trigger separate push workflows). A release commit
  may be smoked twice (ordinary push, then release call): this deliberately buys
  fresh, direct dependency evidence rather than an attestation lookup.
- One non-cancelling lock serializes all staging deploy/smoke runs, including
  release calls. Both this lock and release-production use **queue: max**:
  [GitHub queues existing waiters in FIFO order instead of replacing them](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).
  A main push cannot evict a release already waiting for staging, nor interrupt
  an active smoke. GitHub permits 100 pending entries per group; at capacity it
  rejects new arrivals, not existing waiters. Monitor/drain the queue before
  release if saturated; retry a rejected run after capacity is available.
  No cancellation or skipped staging run ever authorizes production.
  Release's release-production lock serializes releases through npm;
  production shares the migration lock. Later main runs may update staging after
  the release smoke completes, but production uploads only the already-smoked SHA.
  A tagged recovery deliberately re-deploys that release SHA to staging; dispatch
  current main afterward if staging must immediately return to its tip. If newer
  main migrations already advanced staging, Supabase may refuse the older release
  checkout because of remote-only migration history, even with additive SQL.
  This fails closed: cut a forward release including those migrations, or
  freeze/drain merges before cutting the intended release. Never repair/remove
  migration history just to force an older release through smoke.
- Missing configuration fails closed in opted-in mode; failed staging visibly blocks
  production and npm. Manual smoke remains diagnostic only and uses the separate
  post-deploy-smoke-staging lock, so it can overlap a gated staging deployment.
  Run diagnostics only after the pinned staging run completes and while no next
  deployment is queued (freeze merges if needed); never treat their result as
  release evidence. Independent staging
  migrations/deployment-event smoke and standalone production migration applies
  are disabled in gate mode; history/repair/preview remain operator tools.

Existing smoke lifecycle expansion remains tracked by #819/#826/#827. This ticket
gates on the existing sandbox smoke contract, not an unimplemented quality claim.
Migrations must stay additive/compatible with old running code.

### Exact owner cutover (no agent performs these operations)

1. Freeze merges and drain release, migration, smoke and host deployment runs.
   Record known-good Railway deployment IDs, Vercel URLs and source SHAs for both
   environments; verify database history/backups with the database operator.
2. GitHub Settings → Environments: allow **main and version tags v*** for staging
   and production (tag-triggered reusable staging calls need staging tag access).
   Deny arbitrary branches. Restrict dispatch/configuration to release owners;
   optional production reviewers add approval before production mutation. Keep
   npm OIDC protections unchanged.
3. In **each** environment populate the exact secret table under release-sync
   above, with its own values: SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_ID,
   SUPABASE_DB_PASSWORD, RAILWAY_TOKEN, RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID,
   RAILWAY_SERVICE_ID, ARMADA_SERVER_URL, VERCEL_TOKEN, VERCEL_ORG_ID,
   VERCEL_PROJECT_ID. Supabase token: authorized account access-token settings;
   project reference/password: matching project settings. Railway IDs: project
   settings; token: project token scoped to that environment. Vercel token:
   account Settings → Tokens; team/project IDs: matching project Settings.
   Staging uses its existing separate dashboard project; CLI --prod means that
   project's staging domain, not the production dashboard.
4. In staging configure variable ARMADA_ORIGIN and secrets ARMADA_SMOKE_TOKEN,
   ARMADA_SMOKE_CASES per [smoke setup](post-deploy-smoke.md). Mint the bearer for a
   dedicated staging Armada user; cases reference staging goldens/model accounts
   covering enabled pairs. ARMADA_SERVER_URL must match ARMADA_ORIGIN.
5. Railway: disable production Git auto-deploy from main (disconnect its source if
   needed). Also disable staging Git auto-deploy because the serialized workflow
   now owns it. Keep domains/runtime variables, root Dockerfile and /healthz checks.
   Vercel: on both dashboard projects move the production branch to a protected
   non-developing branch such as production-disabled as described above; keep
   PR previews, apps/dashboard root, workspace inclusion and environment variables.
   Disable other hooks/writers that can promote main; an independent writer defeats
   the staging lock. No deploy hook tokens are needed.
6. Set repository RELEASE_SYNCED_DEPLOYS=true then STAGING_GATED_DEPLOYS=true
   **last**, under the freeze. Dispatch main staging, then cut/recover a reviewed
   release and verify below before lifting the freeze. Merely merging this PR does
   not stop today's production Git auto-deploys. If incomplete, leave variables
   off and restore prior host settings under the freeze.

### Coordinator proof, emergency override and rollback

Record production IDs/history. Verify an ordinary main merge updates staging but
does not mutate production or publish npm. Cut a throwaway release with deliberately
failing staging smoke (e.g. invalid staging golden): release staging must be red,
production and npm skipped, production IDs/history unchanged. Restore the case;
recover that same validated tag, verify green and compare full SHA in staging and
production Railway messages, Vercel githubCommitSha metadata and release Actions.
Exercise the review's cancellation scenario explicitly: keep the release-commit
push smoke active, let Release finish check/binary and queue its staging call,
then merge another main change. Verify the pending release call is retained,
the new push queues behind it, and the release reaches production/npm only after
its own smoke succeeds. No production source may differ from that successful
staging-call SHA. Also verify a failed/cancelled staging call blocks both stages.
Owner performs these deployed
checks; local lint/tests cannot prove platform settings. Never intentionally fail
production. Use a forward hotfix release if a newer stable tag supersedes recovery.

Emergency override: owner freezes/drains writers and records incident approval,
keeps RELEASE_SYNCED_DEPLOYS=true and all host Git deploys **disabled**, temporarily
sets STAGING_GATED_DEPLOYS=false, then recovers a reviewed latest stable hotfix tag
through Release. This explicitly bypasses smoke, not the release boundary or
migration/server/dashboard/npm ordering. Record why, SHA and run URL; restore the
gate variable before lifting the freeze. No standalone migration applies in parallel.

Rollback: freeze/drain writers; owner restores recorded known-good Railway and
Vercel deployments through provider rollback controls after checking compatibility
with applied schema. Never automatically undo migration history/down-migrate.
Prefer a new forward fix/revert release. Follow partial-release recovery above if
schema/server advanced but dashboard/npm did not.

### iOS TestFlight

TestFlight remains independent: main pushes changing apps/ios (or manual main
dispatch) verify, archive and upload to the Armada Internal tester group, using
the testflight environment. It neither triggers nor authorizes server/dashboard
production, migrations or npm and is not a release dependency. Its existing
APP_STORE_CONNECT_API_* and IOS_DISTRIBUTION_CERTIFICATE_* secrets remain in that
environment (see apps/ios/README.md); no new iOS credentials/settings are required.
Changing TestFlight's beta cadence or coupling its app binary to release tags is
outside this small deployment-gate PR.
