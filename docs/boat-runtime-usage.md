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
counters/models/prices remain unknown. In particular, Codex can omit
`cacheWriteInputTokens`: its counter remains null and the current shared pricing
policy then reports `cost.unknown: tokens`, not an invented zero or complete
priced subtotal. This is **not** a declaration that positive real Codex cost
parity is finished. The next usage slice must resolve any actual harness/price
dimension gap before subscriptions; do not hide it by guessing counters.

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
attribution and admission preservation**, while `costAfterResume` is explicitly
`priced` or `unknown`. **Unknown cost is not a positive cost-parity pass**; retain
that orange table row and report the reason. Existing MCP, GitHub, skills,
memory, epoch+1 and stopped-history gates remain mandatory in the same run.

Offline proof: the real encrypted upload/SQL path prices known observed tuples
at exact literal amounts, ignores forged guest USD, freezes admission despite
later price edits, deduplicates replay and survives epoch replacement; missing
cache writes retain null / unknown cost. The existing archive/projection rollback
test still proves ACK follows atomic commit. Canonical smoke cases reject absent
usage/admission, wrong counters and resumed repricing, and explicitly distinguish
unknown cost from zero. No real provider/model call is made by these tests.
