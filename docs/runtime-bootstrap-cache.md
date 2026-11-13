# Runtime artifact delivery and cache (#1161, slice 2)

This slice adds the public artifact route and the runtime's `install-artifact`
mode. It does not yet opt Boat launches in, deliver model configuration, enrol a
runtime, or change Modal's tunnel. Those are subsequent #1161 slices. It is
independently mergeable before the compiled build PR #1185.

## Server publication

A normal Docker/Railway build publishes both Linux x64 and arm64 compiled
runtimes, each manifest's harness archives, and the pinned OpenCode binaries.
No separate copy/publication step is needed. The image defaults
`ARMADA_RUNTIME_ARTIFACT_DIR=/opt/armada/runtime-artifacts`; an explicit
environment variable overrides it (an empty value disables the route).
Files are root-owned, mode 0444 in a 0555 directory, readable by the server's
unprivileged user. Only public executable/archive bytes are published.

`bun scripts/publish-runtime-artifacts.ts` cross-compiles both runtimes on
Linux with pinned Bun and both architectures' optional npm dependencies
(`bun install --frozen-lockfile --os linux --cpu '*'`). It executes no foreign
binary. Native execution/ABI validation remains a separate staging check.
Every selected file's digest and byte count must match or the build fails.
The same build manifests are saved at `/opt/armada/runtime-manifests/{x64,arm64}.json`
for launch configuration and coordinator verification; never use a manifest
from a different build. The directory contains lowercase SHA256 filenames,
not mutable aliases, configuration, tokens or credentials.

`GET` and `HEAD /api/runtime/artifacts/<sha256>` are public, immutable-cached
routes. The installer independently verifies downloaded bytes.

## Installer

The trusted launch/resume bootstrap will resolve a pinned descriptor and invoke:

```sh
armada-runtime install-artifact < private-install-input.json
```

The example file is only for non-secret artifact metadata; the future enrolment
token and model configuration must still travel on private stdin, never argv or
this file. The input shape is:

```json
{"serverUrl":"https://armada.example","cacheDir":"/home/user/.armada/runtime-cache","artifact":{"sha256":"<64 lowercase hex characters>","bytes":82273760}}
```

The mode works inside a pre-filled compiled binary without a shell. It returns
one JSON receipt containing the installed path and does not execute it or mutate
the running executable. The runtime version must change only at start/resume;
launch wiring must never call the installer to hot-swap a running session.

The cache directory must be private. A matching byte count **and** SHA256 is a
warm hit with no HTTP request. A missing/corrupt entry is downloaded over HTTPS
from the configured Armada origin, without credentials or redirects. Streaming
bounds, digest verification and atomic rename prevent partial/corrupt bytes from
becoming executable. Interrupted downloads remove their temporary file and do
not replace an existing entry. Each request is bounded at two minutes and each
artifact at 512 MiB. Only explicitly requested digests are fetched; selection of
the harness and safe archive extraction belong to launch bootstrap wiring.

## Coordinator staging check

There are no migrations or manual artifact-publication prerequisites.
After deploying the image, extract its two runtime manifests. For every
`runtime`, `harnesses.*.archive` and `opencode` entry, run:

```sh
curl -I https://armada-mcp-staging.up.railway.app/api/runtime/artifacts/<digest>
```

Require HTTP 200 and Content-Length equal to that entry's `bytes`.
These are the exact coordinator checks for #1324; workers deploy nothing.

1. GET each digest as well and check its SHA256 against the image manifest.
2. Run `armada-runtime install-artifact` with the JSON input above (substitute
   staging origin, exact manifest digest/size and a fresh private cache path).
   Expected: JSON path receipt, file mode 0700, bytes hash to the manifest.
3. Repeat with outbound access blocked. Expected: same receipt from warm cache.
4. Corrupt the cache entry; restore outbound access and repeat. Expected: repaired
   digest. Publish wrong bytes or remove the server file and repeat with a fresh
   cache: nonzero exit, no executable/partial entry published.

No model call or Boat compute is needed for this slice's staging check. The full
Boat lifecycle smoke and launch-time before/after measurement remain required
when enrolment/channel/launch wiring are delivered. No deployment was performed
by the worker.
