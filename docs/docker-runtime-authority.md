# Docker runtime authority (#1165)

This internal slice reuses the existing enrolment, epoch, command and journal
authority for persisted private Codex Docker rows. There is no public Docker
launcher/issuer or provider registry entry yet. Boat behavior is retained;
Modal still uses its existing path and cannot enrol through this authority.

## Explicit issuance and retained validation

Trusted code must construct createRuntimeEnrolments with allowDockerIssue: true
before issuing a new Docker ticket. The default refuses Docker issuance.
This is not an HTTP/body option. A future production launcher must set it only
under explicit Docker launch enablement; no production Docker issuer is wired here.

Default validators can exchange/validate legitimately opted-in tickets and live
grants. Retained command/event and credential paths do not need to re-enable
new issuance. Tokens, sealed configuration, one-use exchange and runtime epochs
keep the existing protocol: no host-level model/prompt API or new token scheme.

A Docker source must match its registered host, org and installation snapshot;
the host must remain active and unrevoked. Both owner and issuer must still be
members. All source memberships are locked in UUID order before credential,
host, sandbox and epoch work. Native publication/access-only delivery take the
same prelocks before credentials, then pass a frozen transaction-bound receipt.
A receipt from a completed/different transaction cannot authorize later work.

A new service-only nullable docker_issuer_fence column stores issuer identity
plus its existing MCP actor epoch. Each grant read/exchange compares it with
current authority under those locks. Issuer role/removal/rejoin or identity
changes cannot revive old runtime grants, even if host registration remains.
Boat grants use null and retain existing behavior. Host credential expiry and
membership policy are not changed.

## Scope and remaining work

No new user-JWT grants or model-secret columns. Default launch TTL remains the
existing four hours; host credentials remain revocable without expiry, no disk
quota. No goldens, resume, Hosts UI or gVisor. Agent-runtime/provider-boat untouched.

A host ACK remains handoff, not runtime readiness. Docker lifecycle-generation
changes still revoke authority through the existing generic fence; this does not
generalize Boat-specific turn handoff exceptions. Public placement/DTOs, account
configuration, readiness/launch/prompt/history/stop/delete wiring and final SSH
install/register/one-prompt smoke remain subsequent work.

## Exact coordinator checks

No worker deployed or applied remote migrations. Locally, with no sockets,
Docker daemon, inference or sleeps:

```sh
bun test packages/mcp-server/test/runtime-docker-authority.test.ts packages/mcp-server/test/runtime-enrolment.test.ts packages/mcp-server/test/runtime-native-auth.test.ts packages/mcp-server/test/runtime-events.test.ts packages/mcp-server/test/runtime-commands.test.ts
bun scripts/db/check-migrations.ts origin/main
```

Expect default-off issuance, one-use/epoch rejection, host/member/issuer-fence
denials, encrypted journal ACK and distinct-owner native publication/access-only
model delivery to pass on migrated PGlite. These are synthetic protocol proofs,
not evidence of Codex inference or a real Docker placement.

After normal coordinator staging migration, use staging-only libpq environment
(no credentials in argv) and run:

```sh
psql -X -v ON_ERROR_STOP=1 <<'SQL'
select column_name,is_nullable,data_type from information_schema.columns
 where table_schema='public' and table_name='runtime_enrolments'
 and column_name='docker_issuer_fence';
SQL
```

Expected one row, nullable text. Do not enable a public Docker launch based on
this catalog check; the final integration PR still owes real-host lifecycle proof.
