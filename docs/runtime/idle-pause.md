# Runtime idle pause (first delivery of #1562)

The server checks enrolled Boat and Modal runtimes and eligible Docker hosts once per minute. The default
quiet period is ten minutes, configured globally with
`ARMADA_RUNTIME_IDLE_MINUTES` (positive whole milliseconds after conversion).
There is no per-user setting. Native Boat and Modal use the leased lifecycle worker and the same delay, with their own quiescence evidence.

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
Pause wording and #1532 debt rows are implemented. Provider staging verification remains outstanding.
This PR does not claim the issue's end-to-end acceptance criteria are met.

The coordinator must validate idle shutdown and conversation-preserving wake
on staging for Boat, Modal and the owner's Docker host after the follow-ups.
No provider lifecycle or staging operation was run for this implementation.

## Idle-pause presentation

The wire status and filter remain `stopped`. Only an automatic idle stop sets
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


## Docker idle checkpoint, host stop and ordinary-send wake

Docker uses the same global idle delay and archived-terminal-turn detector, not
an independent host timer. Automatic pause requires placement/bootstrap to be
configured and a registered host daemon supporting resume (2.28.0 or later).
Older/unknown daemons are skipped before checkpoint, never silently stopped.
Pending commands, unknown task identity, active turns, application-secret taint
and the existing archive bound remain conservative exclusions.

The owner-authorized common checkpoint fences all runtime mutation admission.
Only its synchronized current-epoch watermark allows the Docker host store to
atomically mark an idle stop and enqueue the existing retained-container stop
job. The normal host ACK publishes stopped; an ACK is not a runtime checkpoint.
The Docker allocation, generation, workspace volume and absolute expiry stay
unchanged. No provider adapter or Boat alias is introduced.

Resume bootstrap embeds the sealed epoch/watermark/conversation proof in its
new private runtime configuration. Readiness requires the guest to attest that
restore, not just generic health or a host ACK. Ordinary send reuses this
existing host resume path and continues the saved conversation. Pending wake
retries keep the same UUID; same-epoch accepted prompt replay does not duplicate
the turn. A UUID belonging to a previous prompt is rejected while stopped,
rather than reactivated as new work; use a new UUID for a genuinely new message.
Existing explicit unsealed manual stop/resume remains available.

No Docker, Modal or Boat staging success is claimed by unit tests. Run the
coordinator procedure in #1562 and retain provider compute/recall evidence.
Native Boat/native Modal are handled by the leased native lifecycle path described below, not by this enrolled-runtime worker.


## Native Boat / native Modal

The existing generation-fenced lifecycle worker also detects idle native
sandboxes using the same global delay. It requires a bound model account, no
application-secret taint, no unresolved activity lease, a terminal current
prompt and its terminal event in the bounded newest 200 events. Boat must
report every conversation inactive; Modal must report quiescence for its exact
physical generation with a synchronized event watermark. Missing/unknown ports,
active turns, missing history and unbound legacy workers stay live until the
ordinary TTL policy or explicit owner action resolves them.

Automatic idle stop substitutes a non-interrupting quiescence check into the
existing work-preservation path and checks again before stop. It never calls
native interrupt to make an idle candidate quiescent. If work becomes active or
unknown after the stop intent, the intent waits without interruption. Its
fence cannot be canceled by a racing send; wait for confirmed stopped before
sending. The provider's normal retained-disk/checkpoint stop remains responsible
for workspace/conversation retention, and TTL expiry still takes priority.

An expired native activity lease with an unresolved identity remains unknown,
not proof an exec ended. Observation alone no longer clears that identity and
makes the sandbox falsely eligible on the next sweep. Terminal/explicit TTL
cleanup retains its existing behavior.

Sending to a confirmed native idle pause uses the existing normal native resume
path but does not renew or rearm the original logical deadline. Expired idle
pauses refuse activation, and the same rule is enforced atomically at admission.
Manual (non-idle) stop/resume deadline behavior is unchanged. The provider's
physical deadline remains its existing native adapter contract; this policy
keeps Armada's logical expiry fixed and its existing expiry cleanup in force.

These are deterministic code-level checks, not staging evidence. The coordinator
must still observe actual native/provider shutdown and same-conversation recall
on staging. The deployed setting override has not been inspected here.

Once native Modal has durably entered checkpoint/snapshot/terminate, its own
stop reconciler owns the transition. Idle retries do not run active-only
observation or Git recapture against that fenced incarnation; they delegate
the existing stop reconciliation with a retention-required policy. Automatic idle
must not use ordinary stop's compute-only failure fallback: failed checkpoint
or unknown snapshot outcomes retain the source and refuse destructive cleanup,
never blindly retry snapshot/create. Explicit and TTL cleanup keep their
existing default policy. A provider-reported lost workspace is failed, not
advertised as a resumable paused sandbox.
