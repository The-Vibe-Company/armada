# Inert golden helper (slice 0)

Scope: new and rebuilt Boat and Modal goldens only. No daemon, runtime identity,
GitHub refresh, usage collection, secret delivery, socket or spool is installed.
Existing goldens and workers are not silently upgraded.

## Coordinator staging check

After this revision is available in **staging**, preserve a golden's persisted
repository, branch, directory and init config and rebuild it with
`armada golden update`. Do this for both Boat and Modal (including `smoke-modal`).
Use disposable staging workers, never production resources.

- Verify the installed helper's SHA-256 against the pinned distribution manifest
  and its persisted golden version/digest/protocol receipt.
- Execute the helper as the normal worker user on root-built and no-sudo images.
- Check that an invalid digest refuses installation before execution.
- Run the pre-snapshot scan; confirm no helper runtime grants, tokens, sockets,
  brokers or private spools are captured. Scan uncertainty must refuse publication.
- Launch from the rebuilt golden and verify protocol negotiation.
- Launch from an old golden: ordinary launches must retain their existing behavior;
  a requested helper-only feature must return closed `unsupported` and a golden
  rebuild action, not fail halfway through a turn.

These are operator staging checks, not claims that staging was exercised by the PR.

## Distribution and protocol

Slice 0 bundles two small static Linux ELF executables in
`packages/core/helper/manifest.json`. This is an immutable release manifest shipped
with the server, not a dependency on an unpublished release URL. Each platform
has its own exact SHA-256. `helper.c` and `build.py` reproduce the bytes using
Clang/LLD; the executable only writes its version (`0.1.0`), protocol (`1`) and
`diagnose` capability to stdout and exits. It never reads argv, environment,
files or credentials and has no networking or daemon mode.

The existing golden provisioning script installs the verified bytes atomically
under `/home/user/.local/share/armada/helper/0.1.0/`, linked from
`/home/user/.local/bin/armada-helper`. It requires neither sudo nor a network
download. Existing golden build ownership normalization makes root-built files
worker-owned. The server re-verifies the installed digest and self-report after
user init and persists its own snapshot-bound receipt, not a guest authority.
Unknown digests, protocols and snapshot revisions are unsupported. Current
compatibility window is protocol 1 only; future protocols need explicit admission.

`launch` accepts optional `helperCapabilities: ["diagnose"]` through the control
API and MCP. Any unsupported requirement fails before provider allocation with
`unsupported` and an `armada golden update` rebuild action. With no requirement,
legacy goldens retain their existing behavior. The shared launch result carries
the negotiated helper status; no helper job, GitHub or usage grant is issued.

Apply `20261111020000_golden_helper_receipt.sql` before deploying this server.
This adds nullable, public-readable, server-written receipt metadata only;
existing rows remain null. No migration or deployment was performed here.
