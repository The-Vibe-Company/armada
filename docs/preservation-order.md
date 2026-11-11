# Boat stop/preservation order (#902)

Status: diagnostic follow-up; **Refs #902**, not a proven production root-cause fix.
No automatic wake/resume, state remapping, or retry-budget increase is introduced.

## What the new evidence proves

Production `7992355e` (2026-11-11): finished Codex turn, one unpublished empty
commit, clean tree; stop at 06:12:24Z, local `collect_exec` refusal at 06:12:29.7Z,
`provider_sandbox_not_ready`, `providerStatus=null`.

In the deployed code `no_status` identifies Armada's compute-state admission
check, not the final response of five refused command POSTs. Actual command
409 exhaustion rethrows Boat's last HTTP 409. The local guard refuses a
terminal state immediately, or an Armada-normalized `starting` state after
its budget. An unrecognized Boat state also normalizes to `starting`.
Elapsed time alone cannot tell those cases apart: GET/quiescence latency counts.

The authenticated issue API was unavailable (401) during this investigation;
the coordinator's supplied production evidence is the source for that run.
No production access or writes were performed.

## Locally established order

- User stop (`tools.ts`) admits a `stopping` database row **with an activity
  lease**, then calls `preserveBeforeStop`, then `provider.stop`. The database
  status is not a Boat stop RPC. The ordinary lifecycle worker cannot acquire
  a row with a live activity lease (`sandbox-lifecycle.ts`).
- Preservation reads the provider, quiesces turns, collects and stores recovery,
  and only then returns to the caller. Pending interruption queues stop;
  timeouts cancel later capture admissions. The lifecycle worker separately
  verifies quiescence before capture. Managed-child stop also honors pending.
- Boat quiescence reads conversations. With no active turn it does not interrupt.
  Otherwise it sends **`/interrupt`**, rechecks settlement, and may defer.
  It does not send `/stop` or `/resume`.
- Ordinary Boat stop runs the model-auth `beforeStop` hook and then `/stop`.
  Managed best-effort stop/retirement uses the archive helper's `/stop` call.
  These are also instrumented, so an unexpected earlier dispatch is observable.

These call paths do not prove which state the production machine returned.
There is not yet evidence justifying a different ordering or an automatic wake.

## Does idle require waking?

The official [Boat API lifecycle reference](https://docs.boat.dev/api/v1#sandbox-lifecycle)
(accessed 2026-11-11) explicitly says `ready` and `idle` accept commands and
`running` also accepts commands. `idle` describes integrated-agent activity,
not suspension. `archiving` means a stop is saving the disk; `archived` requires
resume or fork. The [command error reference](https://docs.boat.dev/api/v1#error-model)
and installed SDK 1.13.0 describe `sandbox_not_ready` as a command refusal, not
an instruction to wake idle compute. No documented idle-suspend state was found.
We cannot infer an undocumented suspension mechanism for this production run.

## Next controlled production run

Filter structured events by Armada `sandboxId` and Boat `providerSandboxId`:

1. `work_preservation_stage`: `source` identifies `user_stop`, `lifecycle_stop`,
   or `managed_child_stop`; phases show initial observation, quiescence and capture.
2. `boat_lifecycle`: shows idle/no-interrupt, interruption dispatch/settlement,
   all ordinary/archive stop API dispatches, and resume dispatches if any.
3. `boat_preservation_exec`: group by `execId`. Every attempt logs its number,
   limit, elapsed milliseconds, `collect_exec`/`chunk_exec`, the observed
   allowlisted `providerState`, `normalizedState`, `stateMappingKnown`, and
   `physicalExitConfirmed`, `autoStopAt`, and `stoppedAt` (when supplied). Decisions distinguish `wait_starting`,
   `startup_budget_exhausted`, `refuse_terminal`, and command dispatch.
   Command responses distinguish HTTP refusal (with status/retry decision)
   from a local state refusal. No command/output, labels, URLs, or error text
   is logged. Unexpected free-form state text is `unrecognized`; known diagnostic
   aliases such as `suspended`/`stopped` are observable but are **not** admitted.
4. `sandbox_stop_dispatch` identifies the caller immediately before physical
   stop; `boat_lifecycle` then distinguishes the before-stop hook from the API.

Repeat ahead-one/clean-tree and fully-pushed reviewer stops. If initial state
is usable but changes after quiescence, the attempt records will show it. If
it was already terminal, no wake/exec is attempted. If an unrecognized/suspended
state is returned, investigate the provider contract before admitting or waking
it. If genuine startup persists, measure the transition rather than raise counts.
