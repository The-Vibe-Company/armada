# Production smoke golden

This repository does not define or own live golden records or snapshots: those are
stored by Armada's production database and boat.dev. The production **`prod-smoke`**
golden must be rebuilt and snapshotted after this change.

Before taking that snapshot, connect to the golden's master sandbox and run the
setup script from the checked-out Armada repository:

```sh
bash scripts/setup-prod-smoke-golden.sh
```

The script is idempotent. It reads the checked-out root `package.json` for the
exact Bun version and `apps/dashboard/package.json` for the exact Playwright
version, installs that Bun version if necessary, installs with the committed lock
file, then installs Chromium and its Linux dependencies for that Playwright
version. It does not read or write credentials.

Then snapshot the master sandbox using the normal operator flow:

```sh
armada golden snapshot prod-smoke
```

Run the script again whenever the checkout's pinned Bun or Playwright version
changes before rebuilding this golden.
