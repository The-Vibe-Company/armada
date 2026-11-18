# Account pools, health and budget

This is the Step 4 policy design for [#2812](https://github.com/The-Vibe-Company/armada/issues/2812). It applies to model accounts across sandbox providers.

## Why selection changes

[Credential resolution](../packages/core/src/credentials.ts) currently picks an explicit credential, a saved agent default, a personal default or sole personal account, then an org default or sole org account. [Capacity admission](../packages/mcp-server/src/account-capacity.ts) checks `max_agents` and `model_limits` after that choice. [Plan-limit parsing](../packages/core/src/plan-limit.ts) supplies exhaustion evidence. A single choice made before admission cannot use capacity, health or spend to pick the next eligible account.

The target has one selection policy for direct, template and routine launches. It removes implicit org selection. Settings and values for model accounts remain separate from sandbox provider credentials.

## Selection

- A pool belongs to one user and one harness. It stores an ordered list of personal account IDs and a default model. Resolve the requested model once, using the pool default when omitted and the harness default when neither is set. Trying a later account preserves that model. A pool with no eligible member gives an actionable refusal.
- Explicit placement uses exactly the supplied `credentialId`, including a template's bound account where applicable. It bypasses pool order and uses the same eligibility checks. Org accounts require explicit placement by an authorized org member. Scoped child launches must use their authorized account and version under the existing child-grant rules. They never evaluate the owner's pool.
- On every evaluation, the server resolves current authorization, account state and version, harness/model compatibility, capacity, health and budget. Pool membership grants no access by itself. A retry from a queue repeats authorization and admission. An explicit version must match. Reasons exposed to callers must avoid revealing metadata about inaccessible accounts.
- `choose(pool, model, facts) → account | wait | refuse` is pure. Facts include the evaluation time, the authorized candidates and their eligibility data, and whether the caller's admission path supports waiting. Check candidates in pool order and choose the first eligible ID and version. Preserve per-account reasons for skips and for a pool refusal. Explicit placement evaluates a single candidate.
- Selection is advisory until reservation. New launch choice and capacity reservation must agree in one admission transaction before provisioning. Use a consistent lock order across requests, independent of pool preference order, and preserve pool order for the decision. A transaction can serialize admission for a shared account. Subscriptions and API keys both support concurrent use subject to configured caps, with no exclusive sandbox ownership.

| Candidate state at evaluation | Decision for that candidate |
| --- | --- |
| Missing, unauthorized, inactive, expired, requested version changed, or incompatible with the harness/model | Skip in a pool. Refuse explicit placement. |
| Known exhaustion with a reset in the future | Skip in a pool. Return the exhaustion code and reset for an authorized account. At the reset, evaluate the other checks again. |
| Budgeted API account at or above its cap, or with unknown pricing | Skip in a pool. Refuse pinned admission with the budget or pricing reason. A monthly reset does not make unknown pricing valid. |
| Account or per-model capacity full | Skip in a pool. If capacity is the only remaining barrier and this path supports queuing, return `wait` with the capacity reason. |
| Eligible | Return the account ID and version. |

Launch refuses when all accounts are full and reports each authorized account's reason. A wait result permits an existing queued send to retry the same binding. Budget and pricing failures give a refusal even on a path that supports waiting.

## Health and pinned work

Keep the last exhaustion fact `{code, resetsAt}` for the account version that produced it. Qualifying runtime evidence supplies the code and reset. A missing reset supplies no timed exclusion and must never be filled with a guessed timestamp. Late events for an older version cannot mark the current version exhausted. Ordinary transient provider 429 handling stays with the runtime. Exhaustion with a known future reset skips the account for new selection.

Admission binds the sandbox to the selected account and version. Sends and resumed work reauthorize the binding and apply admission limits to it. If it is exhausted, report the reset and keep the binding. A pool edit, provider error or exhausted account never switches a running turn or silently moves the next send to another account. Send-time failover is deferred under D5.

## Monthly API spend cap

An optional USD cap belongs to each API account and applies across the callers and models using that account. Only org admins can change an org account's cap. Subscription accounts use capacity and exhaustion signals and have no USD cap. Aggregate spend by account ID and UTC calendar month. Credential rotation preserves the account's spend. Publish each frozen turn quote and its ledger increment atomically, counting a replay once. Attribute usage to the pinned account and the UTC month of turn completion. Track unpriced turns separately from priced spend.

For a budgeted account, refuse a new launch or new turn when recorded spend is at least the cap. Return `budget_exhausted` and the first instant of the next UTC month. Unknown requested-model pricing or unresolved unpriced usage in that month's ledger makes enforcement unreliable, so admission fails closed with a pricing reason. A pool may choose a later eligible account. Report the spend as estimated USD and recommend the vendor's hard limit for billing enforcement.

In-flight turns may finish. The accepted overrun is their unposted cost, including turns admitted while a threshold-crossing quote is being published. Admission and quote publication must serialize their view of the account's ledger so new work sees a committed threshold crossing. The bound is the set of turns admitted before that crossing, with no fixed dollar bound.

## Examples

The issue references five owner examples in axis 3 §1. The cases below exercise the policy using public issue evidence and illustrative inputs where the original wording is unavailable.

| Scenario | Result |
| --- | --- |
| Morph has a two-agent limit and is running two agents ([#2069](https://github.com/The-Vibe-Company/armada/issues/2069)). | A compatible later pool member can take the launch. A launch explicitly pinned to Morph is refused before compute allocation. |
| Two Claude subscription accounts are ordered A then B. A reports exhaustion until 14:00 UTC ([#2816](https://github.com/The-Vibe-Company/armada/issues/2816)). | A new launch can use B. At 14:00 A is eligible again if its other checks pass. Existing sandboxes bound to A stay bound to A. |
| An API key is capped at $500 per month ([#2818](https://github.com/The-Vibe-Company/armada/issues/2818)). | At $500 of recorded spend, launch and send admission for that binding refuse until the next UTC month. Pool selection can advance to another eligible account. Unknown pricing on the capped account also blocks admission. |
| The personal pool is full and the org owns a compatible key. | Refuse the launch through the pool. An authorized caller can explicitly place it on the org account, subject to that account's limits. |
| A scoped child launch has an authorized binding to A, while the owner's pool now prefers B. | Evaluate A and its authorized version only. A stale or revoked binding is refused. |

## Scope

This note introduces no durable writes, awaits or leases. The policy applies to Boat, Modal and Docker launches, with the same pinned-account rule for later sends wherever supported. Provider allocation, admission transaction crash points and competing reservations belong to [#2814](https://github.com/The-Vibe-Company/armada/issues/2814). Pool storage and UI, health ingestion, the spend ledger and budget enforcement are implementation tickets under [#2835](https://github.com/The-Vibe-Company/armada/issues/2835).

Full subscription allowance tracking ([#873](https://github.com/The-Vibe-Company/armada/issues/873), [#877](https://github.com/The-Vibe-Company/armada/issues/877)), send-time failover and runtime retry changes are outside this design.
