# Releasing the CLI to npm

The `armada` CLI is published to npm as five packages, all at the version of `packages/*/package.json`:

| Package | Content |
| --- | --- |
| `@thevibecompany/armada` | The `armada` bin: a Node launcher (`packages/cli/npm/armada.cjs`) and one optional dependency per platform. |
| `@thevibecompany/armada-linux-x64`, `-linux-arm64`, `-darwin-x64`, `-darwin-arm64` | The binary compiled by `bun build --compile` for that platform, restricted by `os` and `cpu`. |

The CLI uses Bun APIs, so the package does not ship JavaScript for Node to run. npm and Bun install only the platform package that matches the machine, and the launcher runs its binary under Node 18 or later or under Bun. No postinstall script runs. `npx @thevibecompany/armada`, `bun x @thevibecompany/armada` and a global install all work the same way. The workspace packages (`@armada/*`) stay private: the binary bundles them, and `@boatdev/sdk`, the MCP SDK and zod with them.

`scripts/npm.ts` stages the packages from compiled binaries into `dist/npm`. `scripts/npm-smoke.sh` installs packed tarballs with npm (local and global) and Bun, then runs `armada --version` and `armada --help` from each install. To try it locally:

```sh
bun run build --target linux-x64
bun scripts/npm.ts --binaries dist --target linux-x64
mkdir -p dist/tarballs
for dir in dist/npm/*/; do (cd "$dir" && npm pack --pack-destination ../../tarballs); done
scripts/npm-smoke.sh dist/tarballs linux-x64
```

CI runs the same steps for each of the four platforms, in the binary job on that platform's own runner.

## Cutting a release

1. Bump the version in every `packages/*/package.json`. They must stay equal: a test fails if they drift apart, and `@armada/core` reads its `VERSION` from there. Merge the bump to `main`.
2. Tag that commit of `main` and push the tag:

   ```sh
   git tag v2.0.0-alpha.1 <commit of main>
   git push origin v2.0.0-alpha.1
   ```

3. `.github/workflows/release.yml` then runs these steps:
   - It checks that the tag is `v<version>` and points at a commit of `main`, and that every package carries the same version. Then it runs lint, typecheck and tests.
   - It compiles the binary on each platform's own runner (macOS signs it ad hoc there), then packs, installs and runs it.
   - It stages all five packages, packs them, runs the smoke test on the linux-x64 tarballs, and publishes those exact tarballs. The platform packages go first and `@thevibecompany/armada` last, so the main package never points at a missing binary. Every package is published with `--provenance`.
   - A prerelease version (`2.0.0-alpha.1`) goes to the `next` dist-tag and any other version to `latest`. A package already published at that version is skipped, so a failed run can be re-run.

`Actions → Release → Run workflow` (workflow_dispatch) runs the same jobs from any ref and ends with `npm publish --dry-run`. Nothing is published unless the run was started by a tag.

## Prerequisites (one time)

1. **The npm scope.** The `@thevibecompany` scope must exist on npmjs.com as an org (or user) that the publisher can write to. The name `armada` is taken, and Armada v1 shipped as `@the-vibe-company/armada` (up to 0.2.73). Changing the scope means editing `NPM_PACKAGE` in `scripts/npm.ts`, `scripts/npm-smoke.sh` (the tarball names) and the docs.
2. **The first publication: a token.** npm configures Trusted Publishing per package, and a package must exist before you can configure it. So the first release authenticates with a token:
   - On npmjs.com, create a **granular access token** with read and write access to the `@thevibecompany` scope (or to its five packages), allowed to bypass two-factor authentication, and with a short expiry.
   - Store it as the repository secret `NPM_TOKEN` (GitHub, Settings, Secrets and variables, Actions). It can also be set on the `npm` environment. Never write it anywhere else.
3. **Then Trusted Publishing.** For each of the five packages, on npmjs.com, open Settings, Trusted Publisher, GitHub Actions: organization `The-Vibe-Company`, repository `armada`, workflow `release.yml`, environment `npm`. Then delete the `NPM_TOKEN` secret and revoke the token. The workflow authenticates over GitHub OIDC (`id-token: write`, npm 11.5.1 or later from Node 24) with no secret at all. Optionally set each package to "require two-factor authentication and disallow tokens".
4. **The `npm` environment.** The publish job runs in the GitHub environment `npm`, and GitHub creates it on the first run. Add required reviewers or a tag rule there (Settings, Environments, npm, deployment branches and tags: `v*`) to gate publication.

## Installing

```sh
npx @thevibecompany/armada@next --help
bun x @thevibecompany/armada@next --help
npm install --global @thevibecompany/armada@next
```

Drop `@next` once a version without a prerelease suffix has been published under `latest`. See docs/dave-onboarding.md for configuration and first use.
