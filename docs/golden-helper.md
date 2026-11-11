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

### Reproducing the release manifest

The original Linux x86_64 build used Ubuntu Clang **18.1.3** (`1ubuntu1`)
and the **LLD 22.1.6** bundled with the preinstalled Rust **1.97.1** toolchain,
not an unversioned system `ld`. Its full version identifies LLVM commit
`dcc3606807c989700e0ac1cac18c31741bcd40d9` (build path
`/checkout/src/llvm-project/llvm`). Rust distributes that linker under
`lib/rustlib/x86_64-unknown-linux-gnu/bin/gcc-ld/ld.lld`.

On a Linux x86_64 machine with that Rust toolchain and Clang installed:

```sh
# If needed, obtain the exact Rust toolchain with rustup (not required at golden build time):
rustup toolchain install 1.97.1 --profile minimal
RUST_BIN=$(dirname "$(rustup which --toolchain 1.97.1 rustc)")
export LLD="$RUST_BIN/../lib/rustlib/x86_64-unknown-linux-gnu/bin/gcc-ld/ld.lld"
export CLANG=/usr/bin/clang
"$CLANG" --version  # must report 18.1.3
"$LLD" --version   # must report 22.1.6 and the LLVM commit above
python3 packages/core/helper/build.py
git diff --exit-code -- packages/core/helper/manifest.json packages/core/helper/digests.json
```

The original build was reproduced locally with those exact preinstalled tools;
no golden needs the compiler, linker or Rust. `build.py` emits both the server-only
binary manifest and its digest-only browser contract; commit both on a pin update.
A different linker build can embed a different `.comment` section and therefore
produce a different digest even when its version number matches.

Required helper refusals expose typed `reason` (`helper_missing`,
`helper_receipt_invalid`, or `helper_capability_unsupported`) and
`action: rebuild_golden` in HTTP error objects and MCP error structured content.
The latter reason covers a valid installation that cannot perform the requested
capability. Clients do not need to parse the explanatory English message.
