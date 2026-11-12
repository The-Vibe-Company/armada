# Runtime artifact delivery and cache (#1161, slice 2)

This slice adds the public artifact route and the runtime's `install-artifact`
mode. It does not yet opt Boat launches in, deliver model configuration, enrol a
runtime, or change Modal's tunnel. Those are subsequent #1161 slices. It is
independently mergeable before the compiled build PR #1185.

## Server publication

`ARMADA_RUNTIME_ARTIFACT_DIR` opts the Armada server into serving executable
artifacts. Leave it unset to keep the route disabled (404). Provision this
read-only directory separately; the existing Docker image does not populate it.
Publish only public executable/archive bytes, never model configuration, tokens,
credentials or journals. The directory contains regular files named by their
lowercase SHA256, not mutable version aliases. Symbolic links are refused.

For each output file listed in the compiled build's manifest, an operator copies
the file to `<artifact-directory>/<sha256>`. `GET` and `HEAD` at
`/api/runtime/artifacts/<sha256>` serve it without authentication. These public
files have immutable cache headers. Publication is operator-controlled; the
installer independently verifies the actual bytes, even if publication is wrong.

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

Deploy with `ARMADA_RUNTIME_ARTIFACT_DIR` pointing at a read-only published
artifact directory. This is the only new deployment prerequisite; there are no
migrations. With #1185's compiled artifact built on isolated staging Linux:

1. Copy the runtime executable to the publication directory using the manifest's
   runtime SHA256 as its filename. Check GET/HEAD at the URL above; HEAD must
   report its byte length and GET must hash to that digest.
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
