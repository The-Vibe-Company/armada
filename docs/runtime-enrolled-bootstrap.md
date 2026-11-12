# Enrolled selected-harness bootstrap (#1161)

This slice connects enrolment to the selected Codex installer. It stacks on
#1268. It does **not** opt Boat launches in yet or change Modal's tunnel/build.
Runtime executable delivery/selection and Boat launch/resume wiring remain later
slices; this process runs the binary already selected by its trusted launcher.

## Private startup contract

`armada-runtime dialout` still receives exactly the Armada HTTPS origin and a
single-use enrolment ticket on private stdin, never configuration or credentials
in argv, an environment variable or a golden file:

```json
{"serverUrl":"https://armada.example","enrolmentToken":"<single-use ticket>"}
```

The existing encrypted server-issued enrolment configuration additionally carries
`selectedHarness: "codex"` and `artifactManifest`, the compiled build's manifest
(including the complete selected-harness file inventory). `root` is a private
absolute per-sandbox runtime directory; `codexEnv` is its credential/environment
projection, as before. No new public API exposes this configuration.

Before journal/driver construction or command readiness, the enrolled process
verifies or installs that manifest's selected Codex under
`<root>/artifacts/harnesses`. It ignores the configuration's `codexExecutable` image
path and replaces it with the verified cache executable. The selected artifact's
`codex-path` directory is prepended only to the Codex driver's configured PATH;
model credentials remain in that driver projection, not artifact HTTP requests.
This does not install into the machine's PATH or change exec/Claude environments.

Only Codex is admitted in this slice. Harness-bearing prompt, native-resume,
readable-variable and model-test commands for another harness return
`409 unselected_runtime_harness` before invoking a driver. Other existing dial-out
restrictions (including exec) remain. The legacy/non-dial-out main never enters
this bootstrap, preserving Modal behavior.

Installation is startup-only: no command can mutate selection or artifact
metadata. Every fresh process, including resume, consumes a fresh ticket and gets
its configuration again. A complete verified cache avoids artifact downloads but
**never** avoids enrolment. No ticket/session/configuration is persisted by this
bootstrap. The existing native credential files/journal lifecycle is unchanged.
Run only while old native work is quiescent; wiring host stop/resume admission is
still required before Boat opt-in.

## Coordinator staging check

On isolated staging Linux with Bun1.4.2 and build dependencies, run:

```sh
ARMADA_RUNTIME_HARNESS_SMOKE=local_native bun scripts/smoke-runtime-harness.ts
```

In addition to the existing actual Codex CLI/version/app-server handshake proof,
the newly compiled **main** now runs twice through a private loopback TLS fixture:

1. Cold startup receives only a ticket/origin, fetches its selected manifest from
   enrolment, downloads one Codex archive without credentials, then serves health
   over WSS with the enrolled epoch. An unrelated Claude command is refused.
2. Checkpoint and graceful stop succeed. A new ticket/epoch starts the same root;
   artifact HTTP is denied and WSS upgrade refused, yet verified warm startup
   serves health and checkpoint through HTTPS fallback. There is exactly one
   enrolment per process; stdout/stderr stay empty. Fixture credentials are
   synthetic and memory-only; no model inference/provider/remote call occurs.

Expected output includes `Compiled enrolled bootstrap passed`, followed by the
existing native cache/version/handshake success. This is not the full Boat
lifecycle smoke or its required launch-time before/after (>20% owner decision)
measurement. Those remain required when the launcher opts Boat in.

No migrations or current service deployment prerequisites. Future launch wiring
must issue this configuration using `createRuntimeEnrolments.issue`, publish
public selected archive bytes by manifest SHA in `ARMADA_RUNTIME_ARTIFACT_DIR`,
and deliver the selected compiled binary before invoking this mode. No deployment
or remote migration was performed by this worker.
