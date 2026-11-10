# Turn outcomes and machine health

A turn's failure is not a machine failure. Provider machine moves and recoverable
harness exits close the turn as `interrupted`, with a closed reason
(`interrupted_by_provider_move` or `interrupted_by_harness_exit`). Clients can
offer to resend; Armada never automatically replays a prompt.

Usage limits, expired credentials and other turn errors remain failed turn
outcomes. Only provider machine failures and launch failures mark the sandbox
failed. A live machine returns to ready when a turn ends; stopped/stopping
machines retain their provider state.

No data migration is included: SQL cannot establish whether a provider machine
is alive, stopped or irrecoverably failed. Status reads reconcile non-terminal
historical rows against the provider. Historical failed rows with a recorded
physical exit remain untouched rather than guessing their health.
