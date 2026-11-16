# Snapshot journey release-gate investigation (#2407)

## Reproduction boundary

The reported source is `3c9aefecd86f21207e0db70eb4f90584b0adb193`.
A fresh Linux checkout at that SHA, with no `node_modules` or Next build cache,
was installed with `bun install` and tested with `bun run e2e` (no retries,
no reuse flags, default desktop and phone targets). All twelve snapshot journeys (six per viewport) passed without product or test
changes. Full `bun run e2e` summary: **Test Files 10 passed (10); Tests 50 passed
(50); Duration 203.77s (3m 24s, startup 3.24s)**. Lint and repository/dashboard
typecheck also passed. This does **not** reproduce or
invalidate the coordinator's macOS failure. No product or assertion repair is
justified yet; the release blocker remains open pending the failing evidence.

## Findings by reported failure

- **React key warning:** #2373 already replaced the Tools, cloud snapshot and
  Docker snapshot tag fragments with `ResourceTags`. That server component
  uses `Children.toArray` inside a keyed Fragment, specifically for Flight
  transport into the client `Row`. The clean desktop run did not fail on a
  console warning. Do not add another speculative key workaround without the
  failing console stack and trace from the actual candidate.
- **Boat Build disabled:** the create button intentionally requires an
  admission key, a connected GitHub account, a connected provider and available
  Boat capacity, and disallows pending/finding/active jobs. The journey seeds
  GitHub and removes the Boat limit before opening the page, restoring it in
  `finally`. Its clean desktop builds succeeded for both organizations.
- **Modal option absent:** the form offers connected organization providers,
  not every provider in the catalog. `ensureModal` seeds an org-scoped Modal
  credential before navigation; `org/provider/status` in the fixture reads
  that same credential array. Both clean desktop Modal builds succeeded.

## Shared-state audit

The fixture server is shared across serial tests. Session storage saves browser
identity, not server data. `sandboxes.e2e.ts` setup resets the fixture before
saving Alice and Large sessions. Snapshot journeys configure Modal and GitHub
idempotently and restore temporary Boat limits; the capacity journey must run
before successful builds consume inventory. Launch journeys read launch receipts;
Models and Presets create, rename or remove their own resources. None of those
files resets the server between ordinary test cases. Reordering or separately
running cases must not be assumed to reproduce the full matrix's initial state.
No independent state-dependency failure was demonstrated in this run.

## Why #2393 merged

Browser journeys intentionally do not run on PRs. #2393's PR body records
14/14 targeted snapshot tests and **46/46 full-suite tests**, 215.78 seconds,
plus independent review and lint/typecheck. Its comment reports an unrelated
runtime unit CI failure tracked as #2396. Those are the author's recorded
claims, not proof that the coordinator's later macOS execution passed. The
current matrix also includes subsequent launch/model journey changes.

## Evidence needed before repair or release clearance

On the failing macOS machine, preserve `.e2e` traces, report, console stack and
app log **before** rerunning. Record exact HEAD, Bun/Node/browser versions,
command, working-tree status and whether ports 3100/54399 were already occupied.
Compare against a clean checkout/install with fresh generated Next output.
Do not erase the original evidence or retry a flaky test into a pass.

For a disabled Build button, capture the rendered dialog (including GitHub and
capacity notices and current provider), not only the timeout. For missing Modal,
capture the provider options and fixture provider status/credential metadata
without secrets. For the warning, capture the first console stack and the row's
cloud/Docker identity. These distinguish incorrect fixture setup, stale served
assets and a product contract failure; none has yet been established as cause.

Coordinator staging/production verification: no deployment is required to
reproduce this fixture-only gate. Resolve the macOS discrepancy and run the full
clean fixture matrix before clearing #2407 or the release hold. This report
neither authorizes deployment nor claims production/provider acceptance.
