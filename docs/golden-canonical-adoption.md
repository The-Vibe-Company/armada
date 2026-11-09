# Explicit canonical Boat golden adoption

Deploy migration `supabase/migrations/20261110060000_adopt_canonical_boat_golden.sql`
through the normal migration process before deploying this server. **Not applied to
production by this change.** The unique indexes deliberately fail if existing slot
bindings already violate global uniqueness. Investigate manually; do not delete,
merge, rename, or widen ACLs to make a migration succeed.

Select the exact existing golden UUID from authenticated `golden_list` (MCP)
or `POST /api/v1/golden/list`. Do not select by name alone. Only private owners
and org admins can adopt; membership is required. Other historical goldens,
their snapshots, histories and ACLs remain untouched. Adoption does not make
those other goldens usable through the canonical binding.

## Orchestrator syntax

MCP dry run:

```json
{"name":"golden_adopt","arguments":{"id":"<existing-golden-uuid>"}}
```

Apply, using the receipt returned by that dry run within ten minutes:

```json
{"name":"golden_adopt","arguments":{"id":"<same-existing-golden-uuid>","confirmation":"<receipt-uuid>"}}
```

Equivalent authenticated HTTP requests (POST, Content-Type: application/json,
Authorization: Bearer your Armada token) to `/api/v1/golden/adopt`:

```json
{"id":"<existing-golden-uuid>"}
```

then:

```json
{"id":"<same-existing-golden-uuid>","confirmation":"<receipt-uuid>"}
```

No CLI command is added; CLI remains API-only. Dry runs write a short-lived
server-only receipt but no binding. Confirmation repeats provider verification
and rechecks database authorization and capacity under locks. Conflicts expose
no other golden/account metadata. Changing credentials between phases cannot
redirect a receipt to a different verified account. Expired or changed selections
require a fresh dry run. Receipts are single-use after successful binding.

Provenance requires Boat's current account identity, a ready saved snapshot whose
source sandbox exactly matches the selected row, and access to that sandbox under
the same credential. Missing or unavailable provenance fails closed; there is no
override. Account identity is never derived from a key hash.

## Tests and limits

`bun run verify` covers authorization, provenance, receipts and unchanged rows.
For actual multi-session PostgreSQL locking tests, create a **disposable** database,
apply `scripts/db/supabase-prereq.sql` and all migrations, then run:

```sh
ARMADA_TEST_POSTGRES_URL='<disposable-test-database-url>' bun test packages/core/test/golden-adoption-postgres.test.ts
```

That test inserts fixtures and is intended for a fresh test database, not production.
It proves blocking, adoption rollback versus create, competing-account rejection,
and database-enforced global capacity.

This is not leases/crash recovery, snapshot immutability or lifecycle redesign.
A Boat snapshot can still change remotely between verification and SQL commit:
there is no distributed transaction with Boat. Adoption never renames or rewrites
it. Old pending build reservations remain fail-closed and need separate recovery
work. Receipt retention/garbage collection is also a follow-up.
