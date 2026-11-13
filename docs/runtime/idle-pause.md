# Runtime idle pause (first delivery of #1562)

The server checks enrolled Boat and Modal runtimes once per minute. The default
quiet period is ten minutes, configured globally with
`ARMADA_RUNTIME_IDLE_MINUTES` (positive whole milliseconds after conversion).
There is no per-user setting. Native Boat and native Modal are not changed.

A runtime is eligible only after its current admitted prompt has a terminal
journal event, all recorded prompts have settled, no current-epoch command is
pending, and the entire archived journal has been quiet for the delay.
Admission leases and lifecycle reconciliation also block checkpoint creation.
The idle check repeats under the checkpoint admission lock; the checkpoint
intent then fences new send/exec/steer admission. No checkpoint acknowledgement
means no automatic compute stop. Retry uses the same checkpoint request ID.

Checkpointing happens before requesting the existing retained-work lifecycle
stop. The existing provider adapters perform shutdown; a host acknowledgement
alone is not a runtime checkpoint. Expiry is never extended or rewritten.
The existing lifecycle reports confirmed shutdown as `stopped`.

A turn in progress is never intentionally interrupted by the idle policy.
Detached dev servers/watchers started inside a completed agent turn are subject
to the idle timer, not process-name inspection. Explicit runtime exec processes
that checkpoint cannot quiesce prevent checkpoint completion; uncertainty stays
fenced under the existing checkpoint contract rather than claiming preservation.

Safety bounds: incomplete prompt identity, application-secret-tainted machines,
unreadable history and journals over 10,000 events are not automatically paused.
They retain the normal TTL cleanup. These conservative exclusions must not be
reported as successful idle pauses.

## Native Boat comparison

Armada's native adapter sends prompts through Boat, reads conversation state,
and delegates retained-disk stop/resume to Boat. Its quiesce implementation
interrupts only active conversations. Armada does not configure end-of-turn
auto-pause on that path; SDK/API-side historic behaviour is not established by
this code. Runtime WebSocket idle timeout only closes unhealthy transports:
it never stopped compute, so the explicit server-side idle policy fills that gap.

## Remaining deliveries / staging evidence

This is PR 1: detection and checkpointed stop only. Wake-on-send, user-facing
paused wording, Docker integration and #1532 parity rows remain follow-ups.
Until wake-on-send ships, use the existing explicit runtime resume operation.
This PR does not claim the issue's end-to-end acceptance criteria are met.

The coordinator must validate idle shutdown and conversation-preserving wake
on staging for Boat, Modal and the owner's Docker host after the follow-ups.
No provider lifecycle or staging operation was run for this implementation.
