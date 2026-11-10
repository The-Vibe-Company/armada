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

The opted-in release workflow is globally serialized, with cancellation off,
including npm publication. The production job also shares the legacy migration
lock. GitHub can replace a pending concurrency run; this is not an ordered job
queue. Check the latest release run completed; dispatch the newest tag if a run
was superseded. Do not run manual provider deployments during a release.

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

## Staging-gated production (owner opt-in)

This mode replaces release-sync. Repository variable **STAGING_GATED_DEPLOYS=true**
enables **Staging-gated production** on each main push or main dispatch. Leave it
absent/false until cutover; disabled runs emit a notice and make no remote calls.
Never combine it with RELEASE_SYNCED_DEPLOYS=true.

### Findings and chosen mechanism

Provider Git auto-deploys, independent migration jobs and deployment-event smoke
cannot enforce ordering. Waiting for generic CI does not bind smoke to an
unchanging staging deployment. Hooks building moving main have the same race.
We reuse the release uploader with an archived full triggering SHA for both
environments. This promotes the same **commit**, not the same image: Railway
and Vercel rebuild with environment-specific settings. See
[Railway upload](https://docs.railway.com/cli/up) and
[Vercel deploy](https://vercel.com/docs/cli/deploy).

One workflow-level lock covers staging migrations → staging server/dashboard →
smoke → production migrations → production server/dashboard. Migrations precede
deployments (stronger than requiring them before smoke) and must remain compatible
with old running code. Missing staging configuration fails before mutation; any
staging failure visibly blocks production. Missing production configuration fails
before production mutation. Opt-in is fail-closed, never a fallback to ungated
deploys. With the variable absent, all legacy behavior remains unchanged.

The lock is never cancelled by newer pushes. GitHub may replace pending runs;
every surviving run uploads only its own SHA. Superseded runs/retries are rejected
by a main-tip check before either environment is mutated. If main moves during
smoke, production may reject that run: dispatch current main instead. This is
deliberately conservative. No external/manual writer may change staging during
smoke. Legacy deployment-event smoke and standalone staging migrations are disabled.
Production history/repair/preview remain operator tools, not an alternate apply
path. npm releases remain independent; release-sync deployment is disabled.

### Owner cutover (no agent changes settings or deploys)

1. Freeze merges and drain all migration, release, smoke and host deployment runs.
   Record known-good Railway deployment IDs, Vercel URLs and source SHAs for both
   environments; confirm database history/backups with the operator.
2. GitHub Settings → Environments: allow **main only** for staging and production.
   Restrict configuration/dispatch rights to release owners. Require production
   reviewers if desired (normal deploys then also await approval). Keep npm intact.
3. Populate the full production secret table above in **each** environment using
   matching values. Staging ARMADA_SERVER_URL must equal staging ARMADA_ORIGIN.
   Supabase access tokens come from authorized account access-token settings;
   project ref/password from that project's settings. Railway IDs come from its
   project settings; create a project token scoped to that environment. Vercel
   token comes from account Settings → Tokens; team/project IDs from project
   Settings. Use the existing separate staging dashboard project with the staging
   domain as its production domain: Vercel CLI --prod is project-local.
4. Configure staging ARMADA_ORIGIN, ARMADA_SMOKE_TOKEN and ARMADA_SMOKE_CASES as
   in [the smoke runbook](post-deploy-smoke.md). Mint the bearer for a dedicated
   staging Armada user; cases name existing staging goldens/model accounts.
   Cover all enabled pairs. This gate uses the existing sandbox smoke contract;
   expanded lifecycle coverage belongs to the smoke runner, not deployment logic.
5. Disable Railway Git auto-deploy for **both** server environments, retaining
   runtime variables, domains, root Dockerfile and /healthz checks. On **both**
   Vercel projects use the protected non-developing production branch technique
   above to stop main domain promotion, retaining PR previews and workspace build
   settings. Disable other hooks/automation that can promote main. A parallel
   host deploy defeats the lock.
6. Set repository RELEASE_SYNCED_DEPLOYS=false, then STAGING_GATED_DEPLOYS=true
   **last**. No new repository secrets are needed. Dispatch on main; release the
   freeze only after verification. If incomplete, keep the gate variable off and
   restore prior settings under the freeze. Merging alone does not establish an
   operational gate.

### Coordinator proof, emergency override and rollback

Before declaring cutover complete, record production IDs and migration history.
On a throwaway main change, deliberately fail a staging smoke assertion (or use
an invalid staging golden in the staging cases secret). Verify staging red with
“production ... blocked”, production skipped, production deployment IDs/history
unchanged. Restore the case/revert the throwaway commit; rerun current main,
verify green and compare full SHAs in Railway upload messages and Vercel
githubCommitSha metadata to the Actions triggering SHA. Make two close merges:
no production run may deploy a SHA other than its own successfully smoked SHA.
The owner performs these deployed checks; local tests cannot prove host settings.
Never intentionally fail production.

There is no casual skip-smoke input. Emergency override: owner freezes merges,
drains the pipeline and records incident approval; sets STAGING_GATED_DEPLOYS=false,
keeps host Git deploys **disabled**, temporarily sets RELEASE_SYNCED_DEPLOYS=true,
then dispatches the existing release-sync recovery path for a reviewed latest
stable hotfix tag. Follow its approvals, prerequisites and partial-release
recovery above. This explicitly bypasses staging smoke: record why, SHA and run
URL. Restore release-sync false and staging gate true before lifting the freeze.
Never dispatch standalone migrations concurrently.

Rollback: freeze/drain writers, then owner restores the recorded known-good
Railway deployment and Vercel production deployment through provider rollback
controls. Verify compatibility with applied schema first; never roll back migration
history or automatically run destructive down migrations. Prefer a forward fix or
revert on main through the gate. Old workflow retries are not rollback (superseded
SHAs are rejected). A partial failure can leave new schema/server with old dashboard;
retain additive compatibility and use the partial-release guidance above.
