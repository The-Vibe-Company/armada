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
