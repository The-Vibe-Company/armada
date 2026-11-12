# Compiled runtime artifact (Boat rollout slice 1)

This is build and native-validation infrastructure, not a Boat launch switch.
The existing Modal bundle, tunnel and native build remain unchanged. Bootstrap,
server artifact delivery, enrolment/epochs and dial-out control follow in separate
#1161 slices. Do not enable a Boat runtime launch before those slices land.

## Build

On target Linux x64 or arm64 with Bun 1.4.2 and installed workspace dependencies:

```sh
bun packages/agent-runtime/build-compiled.ts
```

`packages/agent-runtime/dist/compiled/` contains one glibc runtime executable,
`manifest.json`, and the selected pinned Codex harness archive. The manifest
records version, OS/architecture, byte lengths and SHA256 digests. The archive
preserves Codex's resources and executable layout (including ripgrep and the
code-mode host). No Claude binary is included in this slice. The build neither
reads model credentials nor embeds them in the artifact.

The runtime consumes private configuration on stdin. Its current HTTP listener
is for the native smoke only; the future Boat path must use dial-out control,
not expose that listener. The existing GitHub installer detects Bun's compiled
virtual entrypoint and re-executes the executable, not the virtual script.

## Coordinator staging check

After building on an isolated staging Linux host, supply a staging model API key
through the environment, never an argument. This explicitly makes one billable
inference call and creates no Boat or Modal compute:

```sh
ARMADA_COMPILED_SMOKE=create_real_inference bun scripts/validate-runtime-compiled.ts
```

Optional `ARMADA_COMPILED_SMOKE_MODEL` selects an available Codex model. Expected:
manifest digests pass, the compiled runtime boots, and the bundled real Codex
app-server returns COMPILED_OK and emits a turn usage event. The smoke checkpoints
the runtime to close native children, then removes its temporary home. A failed
checkpoint exits nonzero; inspect or discard the isolated host because detached
harness processes may survive an unresponsive runtime. Credentials and harness
output are never printed.

Native x64 evidence: Bun 1.4.2, Codex 0.167.0, runtime 82,273,760 bytes;
Codex archive 171,129,996 bytes. First successful local smoke boot was 2,937 ms
including extraction. This is **not** a Boat launch baseline or a before/after
measurement. The coordinator must measure cold/cache/resume Boat launch times
once the launch slice is wired; a regression above 20% needs owner approval.
Arm64 build support is present but not validated on arm64 hardware here.
