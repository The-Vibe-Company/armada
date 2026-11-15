# Model-account turn slots

Account limits apply to admitted work, not to machines waiting for another message.
Harness terminal evidence (finished, failed or interrupted) frees the turn slot.
Unknown delivery retains capacity until its outcome is known or the owner stops
that sandbox; the server never retries an uncertain native prompt automatically.
Native providers are observed by the existing lifecycle worker; shared-runtime
harnesses publish terminal events directly. No user-installed hook is needed.

Ordinary sends to account-bound machines enter an encrypted, durable FIFO queue.
The receipt's prompt ID is a stable queue alias: status/wait resolve it to the
actual harness prompt after dispatch. Reuse the same request ID and identical
input after uncertain client delivery. Queue dispatch rechecks membership,
account version, sandbox ownership and lifecycle before starting work.
Account lists show working / waiting-for-slot / maximum.

New launches retain pre-allocation refusal at capacity. Queueing them would also
need to persist/revalidate golden, template, placement and allocation inputs;
this queue deliberately owns messages to existing machines only.

## Machine pause is independent

The existing idle policy defaults to ten minutes (`ARMADA_RUNTIME_IDLE_MINUTES`)
and is exposed as `/healthz.idlePauseDelayMs`. Native idle observation and shared
runtime checkpointing remain independent of account admission. The existing
`idle_paused` status displays “Paused — wakes on your next message” in CLI and
dashboard; expired machines do not promise wake.

- Boat uses its retained stop/pause lifecycle, preserving the disk and conversation.
- Modal preserves recovery state and terminates the active sandbox; wake restores
  retained state and resumes the checkpointed conversation.
- Docker checkpoints and issues the host's durable stop operation. Wake uses the
  retained workspace and conversation, subject to host resume capability/capacity.

These paths request physical compute shutdown, not just a logical idle label.
Provider billing/physical shutdown must still be confirmed by the coordinator;
retained storage and an independently running Docker host can still incur costs.
No additional pause implementation is included in this slice of #2153.

## Coordinator-only acceptance

On staging, for each of Modal and the owner-enabled Docker host, use three
sandboxes bound to a limit-2 account. Run two turns and send to the third: verify
its queued status includes account name and working/max, and it begins without
another client request after a turn finishes. Repeat with a paused target,
simultaneous sends, failure, interruption and explicit stop. Check FIFO and account
working/waiting counts, and that an idle ready machine consumes no model slot.

After the advertised idle delay, confirm physical shutdown in the provider
console/host, the paused status in CLI/dashboard, and history recall through an
ordinary next message with the original conversation IDs. Existing natural
idle-pause/wake-on-send smoke instructions are in `post-deploy-smoke.md`.
Boat is not part of the release gate; any Boat production verification is
coordinator-only/on-demand and must touch only its own sandbox. No provider or
production verification was performed by this delivery session.

Deploy the queue migration before the server binary; new metadata queries also
require that migration. Do not run older database schemas with this server.
