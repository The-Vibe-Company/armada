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

## Deployment policy (#1547)

**Token cutover:** both environments now require their Railway token. Disable
staging Git auto-deploy before the next Actions server upload; never use missing
or invalid credentials as permission to return to Git deployment.

Main pushes run **Pinned staging smoke**: migrate staging → deploy pinned server
→ wait for that Railway deployment and public version health → build dashboard
in Actions → upload prebuilt output → sandbox smoke. There is one staging writer,
not an independent migration job plus provider-triggered deployments. No PR,
merge-queue or release-please branch deployment triggers smoke. The main-only
manual **Post-deploy smoke** entry point calls the same deploy/smoke workflow,
using its selected main SHA; it is not a deployment-status subscriber.

Production deploys **only through a publishing Release**. Release Please creates
the tag when the owner merges its version PR; that same workflow validates the
exact tag/SHA, builds binaries, calls staging with that SHA, and requires a
successful (not skipped) smoke before production migrations → server → prebuilt
dashboard → npm. Tag push and reviewed existing-tag recovery keep this same path.
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
Pulled settings/env and generated artifacts live only in disposable runner files,
not the repository. See [Vercel's Actions guide](https://vercel.com/kb/guide/how-can-i-use-github-actions-with-vercel).

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


### Ordering, failures, recovery and deployed proof

Railway CLI 5.71.0 uploads clean pinned source, then the workflow waits for the
**exact returned deployment ID** to reach SUCCESS and public /healthz to report
the source version. Only then does it build/upload the dashboard. Vercel waits
for Ready. npm only follows successful production for publishing releases.
No deploy hook or moving main checkout substitutes for the validated source.

Deployment/smoke and release queues retain waiting runs with queue:max and
cancellation disabled, preserving cleanup and queued release calls. Immediately
before the first mutation, an ordinary main run resolves current main over Git
and skips migration/provider builds/deployment/smoke if a newer SHA superseded
it. This avoids stale deployments without evicting a pending release. Resolution
failure fails closed. After mutation starts, newer main never interrupts it.
Explicit pinned release/manual calls are exempt, so a skipped stale main can
never authorize production. Queued stale workflows may still perform runner/tool
setup before this final admission guard; they do not build or deploy an app. Never cancel a live
smoke blindly: it owns real compute and durable cleanup receipts. Already-running
old workflow revisions/provider jobs are not stopped by a source change.

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

Recover via **Release → Run workflow**, ref main, exact existing latest stable
tag and publish=true. Already recorded migrations/published versions are skipped.
The production job rejects superseded stable tags; cut a forward hotfix instead.
Older tags can fail staging due to newer migration history; never repair history
to force them through. A failed smoke has no variable-based emergency bypass.
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
Ready dashboard/smoke or explicit cadence/quota receipts. Only after the exclusive
writer is proven should normal merges resume. If credentials are wrong, fix
configuration; never re-enable Git as a fallback or restore production following
main without its release migrations. No agent performs provider changes or deploys.

Required secret names that must resolve in **both** matching environments:
SUPABASE_ACCESS_TOKEN, SUPABASE_DB_PASSWORD, SUPABASE_PROJECT_ID, RAILWAY_TOKEN,
RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID, RAILWAY_SERVICE_ID, VERCEL_TOKEN,
VERCEL_ORG_ID, VERCEL_PROJECT_ID, ARMADA_SERVER_URL.
Staging additionally requires ARMADA_SMOKE_TOKEN and ARMADA_SMOKE_CASES, plus
ARMADA_ORIGIN as a variable (not secret) matching ARMADA_SERVER_URL. Use distinct
matching-environment Railway project tokens; inherited Vercel secrets may resolve
as before. Never put credential values in logs, argv, issues or repo files.
