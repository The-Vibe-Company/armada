# Privileged golden OS conformance

Opt-in, networked Docker test; it installs the project-pinned Bun and Playwright/Chromium dependencies. It is intentionally separate from deterministic default unit tests.

```sh
docker build -t armada-golden-os-review scripts/fixtures/golden-os
ARMADA_GOLDEN_OS_IMAGE=armada-golden-os-review bun test packages/core/test/golden-os.test.ts
```

The fixture uses the approved Node/Debian digest and exact apt versions, including sudo `1.9.13p3-1+deb12u4`. It runs the production pinned-host-key SSH stdin checkout transport and the complete generated golden recipe as the unprivileged `user`, then invokes the production scanner through that user's exec channel. Passwordless sudo is inside this disposable container only. Host Git configuration is never changed; fixture Git identity is repository-local.

Only the fixture's GitHub network location is redirected to a real local Git repository. Its project pins Bun 1.3.14 and Playwright 1.56.1. The test verifies actual npm installation, privileged global Bun relinking, Playwright `--with-deps`, user-owned checkout files, root-only secret detection, and an independently copied root-owned runtime Bun remaining 1.4.2. SSH keys are generated at container start, not baked into the image. The token-shaped scanner value and stdin token are synthetic fixtures.

The model executable markers are deliberately not model-conformance proof. This also does **not** certify Modal's image distribution, runner restart, real GitHub installation-token authorization, or the authorized golden restore port. The coordinator/provider owner must run the same production recipe and scanner on an actual Modal builder with the pinned sudo/private runner-Bun image before release.

## Actual provider-image CI gate

CI does **not** use the repaired standalone fixture above to certify the provider image. It generates a Dockerfile from the actual exported `createRunnerDistribution.image()` instructions and `MODAL_IMAGE_LOCK`, then appends only local Git/SSH fixture data:

```sh
bun scripts/prepare-runtime.ts
bun scripts/golden-os-image.ts
docker build -t armada-golden-os dist/golden-os-fixture
ARMADA_GOLDEN_OS_IMAGE=armada-golden-os bun test packages/core/test/golden-os.test.ts
```

The added source-fixture script deliberately never installs sudo, grants sudoers, replaces a runner binary, or bypasses model/credential policy. Missing privileges/private runtime therefore fail the real SSH recipe instead of being repaired by test setup. Actual Modal public-SDK provisioning/SSH/network and stop/restore recipe conformance still require the coordinator's credentialed live gate.
