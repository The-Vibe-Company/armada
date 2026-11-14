# Investigating native Boat command termination (#1424)

## Conclusion

At main `863c95e07bfe3ccac73f90dce42e88f1314a0a03`, normal native Boat GitHub refresh and successful lifetime extension do not signal the harness, and prompt/steer dispatch contains no explicit running-machine restart. Exit 143 is consistent with SIGTERM, not proof of a platform restart or its sender: wrapper failure/signal forwarding and unsafe-extension preservation remain possible interruption paths, but the reported incident cannot be attributed without correlated server and Boat supervisor evidence.

This is a repository trace, not a production reproduction. Do not change renewal
or process supervision speculatively. The earlier issue comment traced main
`e2837974caf3d3af1b95a042f32efe132876030e`; the paths below remain present.
No merged fix PR is linked in the issue timeline; the existing comment delivered
the capture-only acceptance alternative, not a demonstrated production fix.

## Code paths and limits

- `packages/mcp-server/src/tools.ts` GitHub refresh goes through
  `launch-credentials.ts`, `github-legacy.ts` and core's
  `ssh-github-token.ts`. Hydration atomically replaces credential files over a
  separate SSH connection, without explicitly signalling the harness.
  SSH-key authorization on Boat's side is outside this repository.
- `packages/provider-boat/src/provider.ts` `extendLifetime` reads state,
  PATCHes TTL and verifies the returned expiry. Server
  `packages/mcp-server/src/sandbox-extend.ts` renews leases only after a safe
  acknowledgement. An invalid or unsafe shortened deadline instead records
  `stopping`, `expired`, `stopRequested=true` and expiry now, permitting
  preservation and stop. An extension error must not be treated as a harmless
  successful renewal.
- Native `provider.ts` `prompt` prepares the harness and calls `api.prompt`;
  automatic resume applies to stopped machines. `steer` calls `api.steer`.
  Neither explicitly interrupts or stops a running machine. The external APIs'
  internal runner supervision cannot be established from this adapter.
- `packages/provider-boat/src/native-cwd.ts` forwards received TERM/INT/HUP
  to Codex. Failure and cleanup paths can kill the process group; redaction
  failures are not all equivalent to credential refresh.
  `native-claude-mcp.ts` forwards signals and terminates the native process on
  exceptional protocol/configuration/pipe failure. These are potential signal
  paths, not evidence that any fired in this incident or of a four-minute timer.

## Coordinator capture on the next occurrence

Workers need no production access. The coordinator/provider operator should
collect the following without reading auth files or dumping environments:

1. Record UTC command start, last output, exit and the exact claimed restart
   message, preferably with milliseconds. Include Armada ID, Boat `bx_` ID,
   harness, conversation/prompt/tool-call IDs and command timeout/yield settings.
   Distinguish command exit from whole-turn or harness exit.
2. Preserve full command stdout/stderr and raw Boat prompt/event history for at
   least five minutes either side, including raw failure reasons, state and
   expiry. Capture machine identity/boot ID before and after when available;
   exit 143 alone does not establish a reboot.
3. Record refresh/extend/prompt/steer/interrupt/stop request start/end times and
   outcomes. Preserve old, requested and acknowledged deadlines and the exact
   extension error, particularly `extension_state` or unsafe confirmation.
4. Correlate deployed Armada SHA and server logs for both IDs:
   `boat_lifecycle` (operation/phase/path),
   `sandbox_stop_dispatch` (source), `work_preservation_stage`,
   `work_preservation_deferred`, `work_preservation_failed`,
   `boat_preservation_exec`, `github_hydration_failed` and
   `github_legacy_hydration_failed`. Keep the log collector's timestamps;
   missing events in incomplete logs do not prove absence of an action.
5. Ask Boat operators for native runner/agent-server stderr and supervisor/
   machine lifecycle logs for that ID and window: PID/PGID, signal sender and
   reason, stdio closure, runner replacement, host move, TTL expiry and command
   cancellation/timeout. There is no established guest log pathname here.
   Preserve wrapper stderr and harness exit diagnostics. If permitted, collect
   OOM/lifecycle evidence and PID/PPID/PGID/SID without credentials.

Correlate the first terminating event with these records before proposing a
fix. Successful normal renewal alone is not evidence of interruption; an unsafe
extension response, explicit stop, wrapper failure or provider supervisor action
needs its own positive evidence. No staging or production action has been
performed for this document.
