# Detail / logs read latency — #978 follow-up

Baseline: coordinator's #978 staging run at 67969b0b on macOS 27 arm64,
Python 3.14.6, public internet, golden smoke-modal, Modal × Codex, 20 samples.

| Read | p50 ms | p95 ms | bytes |
| --- | ---: | ---: | ---: |
| sandbox/detail | 1750 | 2806 | 743 |
| logs/read | 1398 | 2307 | 58 |
| golden/list | 251 | 329 | 1096 |
| sandbox/list | 335 | 663 | 22474 |

## Diagnosed redundant work (not yet quantified on staging)

- Non-follow logs reads fetched live provider state after reading authorized
  history, although their response is always settled. On Modal that adds an App
  lookup, machine read, another App lookup and live container polling. Avoid this
  entire status path for non-follow reads. Follow reads retain fresh state and
  prompt completion checks; event authorization and pagination are unchanged.
- Active Modal detail validated the immutable App binding in get(), then again
  in physical(). Retain the first verification, source authority check, missing
  physical-ID refusal and live exit poll; remove only the repeated App lookup.
  No authorization cache or SDK lifetime change.

These are proven redundant dependencies, not a complete diagnosis of all
observed latency. The live exit poll, database reads and provider resolution
still cost time. No end-to-end speedup is claimed before the after run.

## Same-method after run

Coordinator: once this candidate is available on staging, use the same host,
network, org, golden and token scope as baseline. From this checkout:

```sh
bun install --frozen-lockfile
# Securely export ARMADA_TOKEN without tracing or putting it in argv.
export STAGING_URL=https://YOUR-STAGING-ORIGIN
export STAGING_ORG=YOUR-STAGING-ORG-UUID
python3 scripts/perf/staging.py --samples 20 --golden smoke-modal > /tmp/armada-staging-after.json
```

The script is unchanged from the baseline method. This creates one billable
disposable Modal × Codex sandbox, then stops/deletes it. Post the full JSON and
deployed revision on #978; verify cleanup.deleted=true. Compare API p50/p95/bytes,
CLI detail and lifecycle observations with the baseline. Do not compare a changed
fixture, a compiled CLI against source CLI, or different network as a clean A/B.
SQL trip counts, internal provider phase durations and browser/phone-open latency
remain unmeasured. Orchestrators are excluded.

Regression evidence: existing control API follow/non-follow table now makes live
compute unavailable for ordinary history reads; only the pre-fix non-follow case
fails. A Modal detail regression fails pre-fix at two App lookups, passes at one,
then verifies the next read still rejects a changed App binding.
