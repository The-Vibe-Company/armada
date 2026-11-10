# Steer refusals (#846)

Steer targets an existing running turn; it never implicitly starts a new one.
If the turn has finished, a provider's explicit `no_running_turn` response means
nothing was delivered. The owner operation now settles `failed` with that code,
leaves the orchestrator `ready`, and preserves its conversation and continuity.
Fetch detail for the new revision, then send the text as a normal message with
a new idempotency key. Retrying the steer key replays the failed receipt.

## Delivery audit

The same rule applies to message/steer admission refusals:
`invalid_request`, `unauthorized`, `forbidden`, `not_found`,
`provider_not_configured`, `sandbox_not_ready`, `payment_required`, and
`rate_limited`. Classification is restricted to the provider dispatch call,
before any receipt was accepted. Later continuity/publication failures are not
reclassified as refusals.

Transport failures, unknown errors and generic `conflict` still leave delivery
uncertain. In particular Modal maps `request_outcome_unknown` to `conflict`;
a non-retryable error is not evidence of non-delivery. This change does not
relax native continuity loss or operation publication fences.

Ordinary sandbox steer already returns `no_running_turn` with “Use send to
start one” and releases its mutation lease on definite refusals
(`tools.ts` steer's `failurePatch`). It does not use the orchestrator's blocked
state machinery.

## Fenced polls

`events_poll=fenced` means `OrchestratorRuntimeStore.appendEvents` rejected
publication because the revision, physical generation, conversation or
expected provider cursor changed between read and transaction. Owner event
reads and the background consumer can race for the same cursor. Finishing a
turn does not itself change these fences. The rejected page is not
acknowledged; the next poll rereads the committed cursor.

The production log in #846 does not identify which comparison failed, so it
cannot prove the precise cause of those two polls. They do not cause the steer
refusal classification bug: that occurs independently in the mutation's
catch-all error path.

## The previously blocked parent

There is **no supported non-destructive command** in this patch to restore
orchestrator `b8cc3340-4362-403b-a586-3972ccd48b7a` to ready. The old operation
persisted only `runtime_uncertain`, not durable provider-refusal evidence.
Current provider idleness cannot prove what a historical request did.

`orchestrator recover` retires compute; it is not a safe in-place repair.
The reconcile endpoint only looks up the recorded request, and Retry replays
that receipt. Do not use either as a claimed repair, edit production rows, or
repeat the old steer to infer its outcome. An evidence-backed historical repair
would need a separately authorized recovery path; this prospective fix does not
invent one or modify existing uncertain records.
