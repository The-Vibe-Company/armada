# Orchestrator authority foundation (#661)

Feature status: **off**. No HTTP/MCP authority route, runtime grant allocation or
provider resource is enabled by this foundation. Ordinary workers are unchanged.

Migration slot: `20261110120800` (208), reserved here for integrator confirmation;
205–207 remain untouched. Apply named credential migration 202 from #612 before
runtime integration, then 208 before deploying server queries. Do not enable
orchestrators until #662/#663 and operator-verified native conformance land.

`OrchestratorAuthority.admit` is a separate principal boundary. Unknown methods,
exec/admin/credential/token operations deny. Its transaction callback reserves a
durable operation only, never performs provider I/O. It locks parent, membership,
generation and delegation through reservation. Child actions require the recorded
same-org/owner child, not an arbitrary sandbox owned by the user. Launch selection
is independent of the parent's harness and requires explicit golden and credential
allowlists plus the current #612 adapter. That adapter must authorize the exact
`credentialId` and `credentialVersion` via `resolveCredentials` for the requested
Claude or Codex harness; no fallback or credential values cross this boundary.
The adapter must serialize credential revocation/version changes with reservation.
It is mandatory, not a mocked production implementation. #604 native state is
not supported merely because this adapter exists.

`installEpoch` is trusted runtime-only, not a public tool or owner token issuer.
The transport must atomically compare-install by physical generation and epoch,
and compare-and-scrub by exact token hash: delayed writes/ACKs must never replace
or erase a newer installed session. It invalidates old epochs before private delivery and opens the new one only after
ACK with fresh membership/state/generation checks. ACK is initial session proof,
not configureMcp hot reload. A grant lasts at most 24 hours; native turns do not
suffer periodic 15-minute expiry. Runtime must drain before the deadline, revoke
and scrub before checkpoint, and prove native continuity before reconnecting.
Stop, removal, rotation and generation changes invalidate admission. Runtime must
call revocation before beginning stop, not after provider completion. Failed scrub
must prevent checkpoint. No secret belongs in prompt/native transcript, command
arguments, public logs, durable events, snapshots or goldens. This module emits
only a constant safe denial, never transport exceptions containing credentials.

Native conformance remains a blocking integration requirement: for both Claude
and Codex on each provider, operator-run tests must show private initial delivery
and ACK, a native turn over 15 minutes with delegated tools still working, stop
and restore generation fencing, scrubbed checkpoint bytes, no token in native or
public logs, and quiescent bounded-epoch rollover retaining native conversation.
Synthetic tests cannot establish provider-native proof. No production runner is
automatically enabled by this PR.

Generic sandbox routes deliberately hide managed parents even from their owners;
use future fenced orchestrator APIs. Direct JWT sandbox reads/mutations have the
same restrictive SQL policy. Cleanup excludes parents; child worker retention is
unchanged. Parent and child ownership relations are server-only and immutable.
Rollback disables admission/revokes epochs; retain identities, receipts and private
native state. Never drop tables or delete machines as rollback.

Real PostgreSQL receipt contention is exercised by `orchestrator-postgres.test.ts`
using the existing migrated disposable `ARMADA_TEST_POSTGRES_URL` CI database.
The test observes an actual blocked backend before releasing the first reservation;
PGlite-only concurrent callbacks are not claimed as row-lock proof.
