# Boat runtime usage / admitted cost provenance (#1161)

This slice fixes the server's runtime-event projection, not model pricing policy.
Runtime uploads already contained harness `armada/turnUsage` observations, but the
query-only enrolment transaction sent the shared SQL writer down its legacy
unpriced branch; the caller also omitted the coherent observation tuples needed
for a quote. The writer now reuses that same outer archive/epoch transaction and
passes the native tuples. No second connection, read-time catalog lookup, guest
money, native Boat collector, Modal change or migration is introduced.

Quotes use the existing pre-work admission book. Replayed event sequences do not
reprice or count twice; a new runtime epoch retains the session admission. Missing
counters/models/prices remain unknown. The pinned Codex **0.167.0** recording
already reports cache writes, so no pricing-policy relaxation, zero inference or
harness upgrade is needed to produce positive cost for complete observations.

The positive-cost contract is now exercised across the real Codex JSONL driver,
encrypted runtime upload, shared SQL pricing writer and the same sandbox store
used by status. The recorded first turn reports 13,143 input / 5 output / 0
cache-read / 13,140 cache-write tokens and prices at USD `0.032906`. A **new
driver process and runtime epoch**, restoring the closed native rollout, reports
only the next turn's 13,163 input / 5 output / 13,140 cache-read / 20 cache-write
tokens: USD `0.00142`, session USD `0.034326`. Replaying either epoch's archive
cannot duplicate those turns. These are exact frozen public catalog estimates,
not guest money or live provider invoices. This offline contract does not claim
real staging inference or that an incomplete observation may be priced.

Missing `cacheWriteInputTokens` still means null / `unknown:tokens`; the test
never fills absent dimensions with zero. Missing model/prices, ambiguous cold
resume history and custom endpoints without explicit rates retain their existing
unknown rules.

## ONE staging lifecycle, batched with the pending skills / MCP check

Deploy this server revision with its parent #1417 (server image publishes the
pinned artifacts normally). Keep the existing staging origin/login/org/smoke
golden/Codex account and remote MCP/GitHub inputs. No usage canaries, price
inputs, explicit skill pins or new credentials:

```sh
ARMADA_RUNTIME_SMOKE=one_real_boat_launch \
  bun scripts/check-boat-runtime.ts --usage --skills --mcp --github --resume
```

Still ONE allocation + ONE same-VM resume activation, four prompts, two stops,
no allocation/activation retry. The skills preflight reads shipped defaults and
refuses before allocation if none are configured. No extra model turns are added.

On each completed prompt, including stopped readback and the first resumed
prompt, require archived `source: armada-runtime` / `type: armada/turnUsage`, a
reported model and positive measured input/output with measured cache reads.
`status.usage.turns` must match those prompt/model observations and every reported
or missing dimension exactly, cover precisely the observed prompts, and have
matching sums (`tokenTotals.incomplete` must remain true for missing dimensions).
A replay/readback cannot duplicate turns/tokens. Each row must carry the frozen
server pricing admission for the selected account/version and same per-model
snapshot; changing prices on resume fails. No missing-admission waiver.

The verifier independently checks exact decimal aggregation of stored quotes.
When all shares are priced it prints `usageProof.cost.status: priced` and USD /
basis; otherwise USD must be null with a closed unknown reason and the correct
unpriced-turn count. Final `usageAfterResume: verified` proves **delivery,
attribution and admission preservation**, and positive cost acceptance additionally requires **every** turn's non-null,
positive `pricing.usd`, positive `usage.cost.usd` immediately after the initial
prompt and after the first resumed prompt, and final `costAfterResume: priced`.
The existing verifier can also print `unknown` for diagnostic runs; its exit code
alone is **not** positive-cost acceptance. Reject unknown/zero cost and retain the
orange parity row until the coordinator records that positive proof. Existing MCP, GitHub, skills,
memory, epoch+1 and stopped-history gates remain mandatory in the same run.

Offline proof: the real encrypted upload/SQL path prices known observed tuples
at exact literal amounts, ignores forged guest USD, freezes admission despite
later price edits, deduplicates replay and survives epoch replacement; missing
cache writes retain null / unknown cost. The existing archive/projection rollback
test still proves ACK follows atomic commit. Canonical smoke cases reject absent
usage/admission, wrong counters and resumed repricing, and explicitly distinguish
unknown cost from zero. No real provider/model call is made by these tests.

## One strict usage + cost + ChatGPT subscription check (#1420)

Use the existing staging environment and an authorized ChatGPT account UUID in
`ARMADA_RUNTIME_CREDENTIAL_ID`; no new variables, credentials or product options.
Run this **instead of**, not in addition to, the lifecycle command above:

```sh
ARMADA_RUNTIME_SMOKE=one_real_boat_launch \
  bun scripts/check-boat-subscription.ts
```

It reads the existing account inventory and refuses an absent, expired, inactive
or API-key account **before allocation**. It then invokes the canonical
`check-boat-runtime.ts --usage --resume` exactly once: one allocation, one same-VM
activation, three prompts, two stops; no allocation/activation retries. The
canonical check owns archived answers, memory, own per-turn usage, frozen quotes,
checkpoints and cleanup. This narrow check does not also claim MCP/skills parity.

Success requires matching runtime-source/epoch receipts, positive measured input
and output, positive `api_equivalent` session USD before and after resume, and an
increase in both turns and USD after resume. A stopped-status read additionally
requires positive first/resumed turn quotes pinned to that account/version and
an exact per-turn sum matching the session. Unknown/zero/API-key cost, missing
resume, stale historical cost or child failure exits nonzero. It prints only an
allowlisted receipt; raw child output, account metadata and tokens are not
forwarded; failed cleanup retains only validated recovery sandbox UUIDs.
Any failed/uncertain lifecycle must be inspected before another run;
the entrypoint never retries it. A successful `subscriptionAnswer:verified`
proves subscription-backed access, not a forced refresh: `refresh:not_claimed` is
explicit. Native-requested shared refresh is covered offline in #1440; real
refresh acceptance needs non-secret server revision evidence, never raw tokens.

Normal server/runtime deployment only; no migration or manual artifact publishing
for this check. Workers do not run it against staging or claim real inference.
