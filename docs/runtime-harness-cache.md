# Selected harness cache (#1161, slice 9)

This slice adds `armada-runtime install-harness`, a no-shell installer for the
selected pinned Codex artifact. It returns paths without executing the harness.
Boat launch opt-in, bootstrap orchestration and lifecycle/timing integration are
still separate work. Modal's bundle/build/tunnel and normal runtime mode are
unchanged. No migration or deployment is performed by the worker.

## Manifest and installation

`bun packages/agent-runtime/build-compiled.ts` still produces the compiled glibc
runtime and selected `codex.tar.gz`. Its existing manifest now also lists every
regular Codex file with relative path, bytes, SHA256 and executable bit. Version
and native layout are retained. The Linux build inventories only regular files,
rejects symlinks and dereferences package-cache hard links while packing, so its
archive and file inventory describe the same bytes. Only Codex is installed by
this initial slice; an unselected/unsupported harness triggers no fetch.

Private stdin to `install-harness` carries non-secret metadata:
`{serverUrl,cacheDir,harness:"codex",manifest}`. `serverUrl` must be an HTTPS
origin without credentials/query/fragment; `cacheDir` is a dedicated private
absolute per-sandbox directory. Descriptor architecture/platform must match the
current Linux x64/arm64 process. No credentials belong in this input, argv or the
public artifact directory. The existing digest-only Armada artifact route serves
the selected archive; no external vendor/CDN is consulted during installation.

A warm extracted directory is verified against the full file inventory (including
mode, size, digest and no extra files/links). Valid image caches need no HTTP or
archive file. Corrupt cache files are repaired from the verified archive cache,
or downloaded from Armada if missing/corrupt. Temporary output is private;
complete verified trees are renamed into a content-addressed directory. Never
run this installer while native work uses that per-sandbox cache: install/update
happens only at start/resume, never as a live binary/version change.

Archive handling uses pinned Bun 1.4.2's `Bun.Archive.files()` regular-file view,
not `extract()`. We validate paths and per-file inventory/hash **before** writing
blobs ourselves; archive symlinks are never materialized, and no tar/shell tool
is needed in the installed image. Partial/truncated reads cannot publish a tree
without the full expected file inventory. Cache limits: 512 MiB per artifact/file,
2 GiB total selected files and 4,096 files. Cold parsing materializes selected
files in memory; this is not a constant-memory extractor.
[Bun Archive documentation](https://bun.sh/docs/runtime/archive) documents the
regular-file view; the pinned API was also verified with real link/truncation
fixtures, not assumed from a newer runtime's extraction behavior.

## Coordinator staging check

On isolated staging Linux with Bun 1.4.2, workspace dependencies, GNU tar and
openssl for the **build/fixture** (not the installer), run:

```sh
ARMADA_RUNTIME_HARNESS_SMOKE=local_native bun scripts/smoke-runtime-harness.ts
```

Expected: build current compiled runtime + selected Codex manifest/archive;
serve its digest through the actual artifact route on private loopback TLS;
compiled `install-harness` downloads once, then repeats successfully with the
server stopped. Installed Codex prints pinned version and real app-server
initialization succeeds, without auth/inference/provider calls. Only fixed
success/failure codes and cold/offline-warm timings are printed. Ephemeral TLS
private key stays in memory; public CA/cache/fixture files are removed afterward.

Worker native x64 proof: 43 selected files, 458,589,813 extracted bytes,
171,129,996 archive bytes; cold 3,910ms and offline warm 543ms. These are isolated
installer timings, **not** Boat launch before/after figures. Measure actual Boat
cold/cache/resume lifecycle once wired; >20% launch regression needs owner choice.
For server publication copy the archive under its manifest SHA256 into existing
`ARMADA_RUNTIME_ARTIFACT_DIR`. Manifest distribution/enrolment bootstrap wiring
remains future work; existing services need no new deployment prerequisite.
