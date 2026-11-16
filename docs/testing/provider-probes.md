# Explicit provider probes

`.probe.ts`, `.release.ts` and `.coordinator.ts` files are excluded from ordinary
unit discovery. An explicit
`bun test ./path/to/file.probe.ts` executes them. A skipped probe is not acceptance.

## Existing automatic publishing proof

`packages/provider-modal/test/artifact.release.ts` retains the exact compiled-runtime
bootstrap/RPC/checkpoint/restore assertions. The existing
`scripts/validate-release-contracts.py` publishing selector
runs it explicitly after the ordinary unit process with the same prepared native
Codex binary. Its existing per-file guard requires a nonempty report with no
failures, errors or skips, including the unchanged native Codex contracts.
There is no new job/check, timeout, retry, image build or provider allocation.
This is offline native distribution conformance, not deployed Modal acceptance.

## Manual diagnostics: not release-gate evidence

- `packages/provider-modal/test/ssh-os.probe.ts` needs the existing pinned
  `ARMADA_GOLDEN_OS_IMAGE` Docker/SSH fixture. Its root/user/NNP matrix has no exact
  automatically deployed replacement claimed here. Obtain resource authorization.
- `packages/provider-boat/test/native-cwd.probe.ts` exercises the actual local TLS
  private-refresh bridge. No exact automatic replacement is claimed. It does not
  allocate a Boat sandbox, but opens local TLS sockets and runs guest scripts.
- `packages/provider-boat/test/integration.coordinator.ts` talks to Boat, starts billed
  sandboxes and spends model credits. It retains the separate
  `ARMADA_RUN_LIVE_BOAT_TESTS=1` compute-consent guard; a key alone is insufficient.
  It is coordinator-only/on-demand, never workers or CI/release acceptance. Any
  coordinator production parity run must retain `--only boat --production-boat`
  and touch only its own sandbox. This diagnostic does not replace that entrypoint.

Boat remains outside staging, pinned and release-gate provider acceptance:
`boat: not part of the release gate`. None of these documented commands is evidence
that it ran or passed. The ordinary staging Modal/Docker probes remain unchanged.
