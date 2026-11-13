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

PR 1 provides detection and checkpointed stop. PR 2 routes ordinary `send` to
the existing checkpointed resume path for stopped Boat/Modal runtimes, without
a provider-specific client request. Use a stable request UUID; identical replay
returns the durable accepted outcome rather than starting another turn, even
after the machine becomes running. Model/effort and the conversation stay pinned.
Resume preserves the original absolute expiry and refuses activation after it.
User-facing paused wording, Docker integration and #1532 parity rows remain follow-ups.
This PR does not claim the issue's end-to-end acceptance criteria are met.

The coordinator must validate idle shutdown and conversation-preserving wake
on staging for Boat, Modal and the owner's Docker host after the follow-ups.
No provider lifecycle or staging operation was run for this implementation.

## Idle-pause presentation

The wire status and filter remain `stopped`. Only an idle checkpoint stop sets
the `idle_paused` status reason; API list/status include additive wording, and
the safe list metadata RPC exposes an `idlePaused` boolean without interior
history or credentials. The CLI says “Paused — wakes on your next message”.
Dashboard badges say “Paused”, with that full message as their accessible label
and tooltip. Ordinary stops, transitions, failures and expired pauses do not
make this promise. A wake clears the marker through normal status publication.

The release migration `20261113180002_idle_pause_metadata.sql` must be present
before running the server version that writes the marker. It extends the
existing stop-reason constraint and metadata RPC, retaining the same membership
and owner/admin masking rules. Type generation was rerun; the generated RPC
uses the shared DTO alias, so no generated-file change is necessary.

## Ordinary client send identity

CLI and dashboard messages use the same ordinary send request, with a UUID
`request_id` regardless of provider. The server selects follow-up versus wake
from immutable runtime identity and stored lifecycle state; clients do not
select a resume endpoint or start a new conversation after pause.

The CLI generates a UUID when omitted. `armada send ID 'instruction'
--request-id UUID` supplies an existing identity for reconciling an uncertain
runtime delivery. Send errors display the request ID; retain it and the exact
original input and inspect status before deciding whether to reconcile. There
is no automatic resend. A genuinely new instruction needs a new UUID.

The dashboard retains the key while the submitted sandbox, prompt,
conversation and model/effort fields are unchanged, and rotates it when any of
those choices change. Runtime-backed composers keep the model/effort pinned to
launch, including Boat/Modal runtimes, not only Docker.

Native providers accept the field for request-shape compatibility, but do not
implement durable UUID deduplication. A repeated native request can run again;
this change does not add native replay guarantees. Deploy the accepting server
before these updated clients: older servers reject UUIDs on native sends.
