# Codex agent bridge (#1161)

`packages/mcp-server/src/runtime-agent.ts` translates live Codex agent operations
onto the fenced durable command caller. It is an internal service, **not a full
Provider**, public API, opt-in switch or replacement for the Boat adapter yet.
Existing Boat and Modal launches are unchanged. It stacks on #1294.

The trusted launcher supplies the persisted owner/logical sandbox ID, Boat
provider ID, validated repository cwd and frozen model defaults. Public requests
must match that exact Boat ID. Runtime commands use the logical ID in both the
envelope and prompt input. Model/effort/fast/conversation choices are delivered
to the Armada runtime, never Boat's prompt endpoint or native cwd wrappers.
Only Codex is admitted. No method resumes compute, opens a runtime port, performs
host agent control or falls back to Boat's native runner.

- `health` requires an identified protocol-1 reply whose ready generation equals
  its fenced reply epoch. Its internal receipt is `{runtime:"armada",epoch}`.
  Launch wiring must first await enrolment; this method alone is not a startup
  retry loop or a public sandbox provenance field.
- `prompt` returns admission, not completion. It accepts an optional stable
  request ID. On uncertain transport/admission failure, the fixed ProviderError
  carries `details.runtimeRequestId` and `runtimeOutcome:"unknown"`. Reconcile
  with the identical request and ID; never mint another ID to retry side effects.
- `getPrompt` and `events` read the live runtime's prompt/journal. Events support
  forward raw cursor pages only; backward/coalesced/byte-budget projections are
  refused explicitly. Stopped-sandbox history and richer stored projections are
  not claimed in this slice.

Reply identities and protocol version are checked. Known runtime refusals map
to fixed ProviderError codes; private error strings never become diagnostics.
No credential values enter this binding, public APIs or errors.

## Coordinator check

Zero Boat starts, deployment or migrations required:

```sh
bun test packages/mcp-server/test/runtime-commands.test.ts --test-name-pattern 'Codex agent bridge|agent bridge refuses'
```

Expected: migrated local SQL + encrypted mailbox + real Runner/journal produce
one synthetic assistant answer, finished status and cursor continuation through
the new bridge. Lost-wait reconciliation starts exactly one driver turn; wrong
sandbox/harness, stale health and unidentified replies fail closed. The harness
is an in-memory test driver: this is **not** a real Codex inference or Boat smoke.
Existing command wire tests own real dial-out HTTP/WSS transport coverage.

Still needed for the one-launch milestone: default-off per-launch selection and
durable routing, encrypted launch configuration/ticket issuance, executable
bootstrap/enrolment readiness, lifecycle cleanup and integration into launch and
later reads. The exact one-launch coordinator check will be posted on #1161 once
main supports it. Do not mistake this internal health receipt for an already
exposed CLI/API field. Claude/default-on/native-runner removal remain later work.
