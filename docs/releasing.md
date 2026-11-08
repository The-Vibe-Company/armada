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
