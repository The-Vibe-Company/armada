# Production smoke snapshot

This is a retained **coordinator-only production maintenance recipe**, not a
staging/release acceptance step or an instruction to rebuild after a documentation
change. Boat is not part of the release gate; print
`boat: not part of the release gate`. On-demand production verification requires
the separate explicit opt-in in [deployed checks](post-deploy-smoke.md#coordinator-only-production-boat-verification).

The repository does not define or own the live **`prod-smoke`** Boat snapshot.
When the owner explicitly authorizes maintenance of that exact resource, select
its organization and stored provider. Use the [Armada maintenance API](golden-create.md#connect-and-scanned-maintenance-snapshot)
to open the canonical master. Send `{"name":"prod-smoke","provider":"boat","org":"ORG_UUID"}`
to `POST /api/v1/golden/connect`.

Using the coordinator's authorized master access, run the setup script from
the checked-out Armada repository before taking the scanned snapshot:

```sh
bash scripts/setup-prod-smoke-golden.sh
```

The script is idempotent. It reads the checked-out root `package.json` for the
exact Bun version and `apps/dashboard/package.json` for the exact Playwright
version, installs that Bun version if necessary, installs with the committed lock
file, then installs Chromium and its Linux dependencies for that Playwright
version. It does not read or write credentials.

Then send the same request body to `POST /api/v1/golden/snapshot` to scan and save
the master sandbox.

Run the script again whenever the checkout's pinned Bun or Playwright version
changes before an owner-authorized rebuild of this snapshot.
