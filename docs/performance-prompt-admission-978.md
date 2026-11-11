# Prompt admission: remove the redundant preparation health RPC (#978)

Night baseline supplied by coordinator: prompt admission about 3.45s, launch
8–12s, prompt-to-first-text 7–9s. The stored-read PR is verified at detail 428ms
and logs 375ms p50. Do not attribute differences from untouched list routes to
this patch or claim an admission improvement before the next staging run.

## Small repair, retained fences

Modal prompt preparation took a lifecycle lease, activated/observed the physical
incarnation and probed native health. After `beforePrompt` configuration outside
that lease it took another lease and repeated physical/health admission. The
first native-health RPC adds a runner HTTP call and, in the real composition,
another Modal connect-token mint. Its result was not used after preparation.

Preparation now uses `readyLeased`: activation/restore, physical poll, source
checks and the captured generation/physical ID/grant/process namespace remain.
The final lease still checks that exact incarnation before and after full
`healthyAdmission`, and only then sends the native prompt. A failed final health
check still prevents submission. Hook failures, checkpoint/restore races and
concurrent stable turns retain their existing behavior. No caching of credentials,
health, App identity or authority; no mutation retry; no migration.

The local no-op preparation-hook regression goes from **two health RPCs to one**
for both successful and unhealthy final admission. Existing configuration and
incarnation race tests remain green. This is an RPC-budget measurement, not a
staging latency claim. Hooks that do their own work may still perform independent
health checks; those checks are untouched.

## Timing and coordinator after run

The existing server breakdown now adds request-local nested phases:
- `modal_prepare`: preparation lease, ready/restore and physical observation.
- `modal_before_prompt`: MCP/authority/readable-variable preparation callback.
- `modal_admit`: final lease, incarnation checks, health and native submission.
- `modal_health`: native health RPC(s), aggregated if independent hooks probe too.
- `modal_rpc`: actual native prompt submission.

These are nested in `send_submit` and `dispatch`; **do not sum them**. The fixed
phase names contain no sandbox/user IDs, prompts or credentials. Async context
keeps concurrent HTTP requests separate; MCP calls without a timing context keep
the same behavior. The macOS-compatible staging script records the new phases
in the existing `prompt_admission.serverMs` map. Missing phases are absent, not
zero; client wall time and decoded payload measurements are unchanged.

After merge/deploy, coordinator on the same host/network/org/fixture runs:

```sh
bun install --frozen-lockfile
# Securely export STAGING_URL, STAGING_ORG and ARMADA_TOKEN as before.
python3 scripts/perf/staging.py --samples 20 --golden smoke-modal > /tmp/armada-prompt-after.json
```

Post deployed SHA and full JSON on #978 and confirm cleanup.deleted=true. One
billable disposable Modal × Codex launch; no provider allocations in this coding
session. The next small PR separates handler work from scaffolding within the inclusive
API dispatch interval (~0.2s); launch phases and dashboard loading/bundle follow.
Orchestrators remain excluded.
