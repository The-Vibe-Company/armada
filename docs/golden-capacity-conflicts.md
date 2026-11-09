# Golden slot conflict errors

Secure create/rebuild reports a known backend-capacity, existing-build or global
binding conflict as HTTP 409 with error code `conflict`. MCP returns an error
result with `error code: conflict`. The generic message advises using an existing
accessible golden, waiting for an active build, or asking an administrator to
check the binding. It never identifies another account, golden, owner or ACL.

Translation is restricted to SQL issued by the backend-slot reservation/finalize
wrapper:

- SQLSTATE P0001 with the exact migration-owned capacity-reached or
  build-already-in-progress message.
- SQLSTATE 23505 for exactly `public.golden_backend_slots` and the named
  `boat_backend_one_slot` or `golden_backend_one_binding` constraint.

Bun's PostgreSQL driver exposes SQLSTATE via `errno` under
`ERR_POSTGRES_SERVER_ERROR`; pg/PGlite expose it via `code`. Both forms are
covered. Raw database details are not copied into the public conflict.
Other P0001 raises, unique violations, invalid arguments, outages and provider
errors are not relabeled as capacity conflicts. HTTP retains its existing
500/unavailable fallback; MCP retains its existing unexpected-error behavior.

Tests drive authenticated HTTP and MCP over the real migrated SQL schema,
including hidden-private and cross-org capacity, pending builds, busy rebuilds
and both unique-binding guards. They assert no provider allocation and unchanged
golden/slot rows. Negative controls use actual unrelated SQL errors and an
exception outside the SQL boundary. Token-only CLI coverage verifies a 409 message
remains readable and exits nonzero without local provider/database access.

The existing PostgreSQL concurrency test additionally exercises this translation
with the actual Bun driver, lock contention, competing reservations, busy existing
bindings, and unique-account/golden finalization errors. Run against a fresh,
disposable migrated database only:

```sh
ARMADA_TEST_POSTGRES_URL='<disposable-test-database-url>' bun test packages/core/test/golden-adoption-postgres.test.ts
```

This changes only the error boundary: no schema, capacity policy, binding, leases,
crash recovery, frontend or release behavior. No production probes or mutations
are required to validate it.
