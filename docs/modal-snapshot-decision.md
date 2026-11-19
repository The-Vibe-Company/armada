# Modal snapshot decision

Status is pending coordinator staging measurement and owner decision (#2826).

The roughly 107 ms image interval in #2565 does not measure repository init.
This experiment measures the cost of fetching Armada's official GHCR image
through Modal and preparing a workspace from a fresh checkout.

## Staging run

1. Use a dedicated benchmark app in the staging Modal environment. Run while
   staging is idle. Set `COLD_MODAL_APP` and `COLD_MODAL_ENVIRONMENT` to that app
   and environment, and supply `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` through
   the coordinator's secret environment. The app must already exist. Use staging
   credentials only. Start from the merged checkout and install dependencies
   with `bun install --frozen-lockfile`.
2. Resolve the staging release's official linux/amd64 image to its immutable
   GHCR digest. Select one public small repository with a real dependency
   installation or setup command that runs on the official image without
   credentials. For both repositories choose a branch or tag and record its full
   commit SHA before starting. The script checks the shallow checkout against
   that SHA on every run. Use trusted repository code and pass the small repo's
   init command as a single argument.

   ```sh
   bun scripts/perf/modal-cold-launch.ts \
     "$IMAGE_DIGEST_REF" "$ARMADA_REF" "$ARMADA_SHA" \
     "$SMALL_GITHUB_HTTPS_URL_ENDING_IN_DOT_GIT" "$SMALL_REF" "$SMALL_SHA" "$SMALL_INIT" \
     > modal-cold-launch.jsonl
   ```

3. Keep the JSONL and record its location, date, staging SHA, Modal environment,
   app and resource defaults. The script alternates five fresh sandboxes per
   repository. It records image resolution/build, allocation through the first
   successful guest command, depth-three clone including SHA verification, init,
   and their wall-clock total in milliseconds. App lookup and cleanup are
   outside the timed interval. Each successful sample ends with confirmed
   termination. If a run fails or is interrupted, record the attempt and reason,
   check the named sandbox in the dedicated app, and confirm termination before
   running a new full batch. The sandbox lifetime is capped at ten minutes.
4. Record first-use image timing separately when the digest was new to the
   environment. Modal can reuse imported image layers, and a fresh sandbox
   does not imply a forced registry cache miss. No snapshot, shared dependency
   volume or mounted checkout is used. A dependency-volume experiment is
   separate from this uncached guest baseline.

## Compare and record

Use nearest-rank percentiles per repository and phase. For five observations,
p50 is the third value in ascending order and p95 is the maximum. Compare the
measured workspace-ready total with the [#2767 staging snapshot baseline](https://github.com/The-Vibe-Company/armada/issues/2767#issuecomment-7003426082).

| Path | Samples | p50 ms | p95 ms | Boundary |
| --- | ---: | ---: | ---: | --- |
| Snapshot, staging REST | 10 | 15,812 | 22,318 | Client request through launch response |
| Snapshot, shared launcher | 10 | 13,613 | 20,214 | Shared launch through harness ready |
| Official image, Armada | Pending | Pending | Pending | Image resolution through repo init |
| Official image, small repo | Pending | Pending | Pending | Image resolution through repo init |

Report the arithmetic comparison and label it with these different timing
boundaries. The snapshot baseline is for a native Codex smoke workload.
The standalone cold run omits Armada admission, runtime enrollment, harness
startup and response publication. It provides a workspace-ready measurement
for each repo and cannot establish end-to-end speedup. Compare the phase
breakdown with #2767 to explain the gap. Avoid adding overlapping snapshot
phases to the cold total or adding per-phase percentiles to estimate total p95.

Record the raw samples or evidence link, phase p50/p95, failed attempts,
recommendation and owner decision here. Consider the 8 s p50 / 12 s p95
end-to-end targets and the headroom left for unmeasured runtime work. Recommend
keeping snapshots if direct image resolution or cold init is unreliable, or if
the preparation timings leave insufficient headroom. Otherwise, use the results
to recommend whether #2827 should validate a full snapshot-free runtime launch
before any snapshot removal. The owner decides whether to proceed.

- Measurement and evidence — pending coordinator run.
- Recommendation — pending measurement.
- Owner decision and date — pending owner review.
