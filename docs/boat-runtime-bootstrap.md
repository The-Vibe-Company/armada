# Boat executable bootstrap (#1161)

`@armada/provider-boat` now exports `startBoatRuntime(provider, input)` for the
trusted launcher. This is a start-only primitive, not yet an API opt-in. No
existing launch changes behavior. Modal is unchanged.

Input names the provider sandbox, Armada HTTPS origin, single-use enrolment
ticket, compiled runtime digest/byte count and an absolute private `cacheDir`
whose parent exists (normally `/home/user/.armada-runtime-bootstrap`). The
launcher must fence/quiesce old work before calling it; never invoke it mid-turn.

The existing scoped SSH stdin transport delivers the ticket privately. Only
public artifact metadata enters the remote command. A Node bootstrap (Node is
already a Boat golden prerequisite) checks cached bytes by size and SHA256;
otherwise it downloads from the Armada artifact route, rejects redirects and
wrong/oversized bytes, and atomically publishes the verified executable.
Symlink/non-file cache entries and non-private cache directories are refused.
Only the compiled runtime is installed here; enrolled startup fetches the pinned
selected harness through the already-merged installer.

The executable runs detached as the Boat user, with only HOME/PATH inherited,
`dialout` in argv and ticket/origin on stdin. No ticket file, guest output or
runtime port is published. Success means the process spawned and consumed its
stdin pipe, **not** that enrolment, harness install or health succeeded. Launch
wiring must await health over the fenced bridge before publishing ready or
sending the first prompt; failed startup must terminate the allocation. This
helper does not retry a consumed ticket or claim stop/resume parity.

## Coordinator check

This slice needs no Boat launch/model call or deployment. Run:

```sh
bun test packages/provider-boat/test/runtime-bootstrap.test.ts
```

Expected: cold verified install and detached execution, warm start with download
forbidden, and refusal of incorrect download bytes after cache corruption. The
fixture is a local executable/HTTPS peer, not proof of a real Boat answer.

The one-launch milestone check cannot yet be run: per-launch opt-in persistence,
enrolment issuance/configuration, readiness and prompt/event routing still need
launcher integration. Do not substitute a native Boat prompt as evidence. No
migrations are included. Future rollout needs published compiled artifact and
selected harness bytes in `ARMADA_RUNTIME_ARTIFACT_DIR`; this PR does not change
server deployment or enable any traffic.
