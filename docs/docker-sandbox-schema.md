# Plain-image Docker sandbox SQL admission (#1165, slice 3f)

Stacked on bootstrap delivery. This is a dark schema foundation, not a Docker
launch endpoint or registry entry. No public API creates these rows; existing
public provider choices/mappers remain Boat/Modal until the next integration.
Do not enable Docker creation before that integration. The legacy mapper refuses
unsupported/goldenless rows rather than inventing a golden reference.
No Docker golden is introduced.

## Persisted identity and authority

Two new migrations add the docker enum, then permit a private Codex sandbox
without a golden. Separate files commit the new enum before its use.
Applied migrations are not edited.

Docker rows bind a host, installation snapshot, generation and pinned image;
the provider sandbox name must match those exact identities. Admission requires
a registered, unrevoked same-org host and current membership of its issuer and
the sandbox owner, locking members before host. Binding cannot move on update.
Trusted cleanup remains possible after revocation or membership removal.
Anon/authenticated Docker mutation is refused, including privileged dashboard
RPCs retaining those caller roles. No new write API is introduced.

No Boat alias or source-golden visibility is fabricated. Boat/Modal still require
real golden/source and retain their lifecycle, identity, visibility and provider
guards. Existing sandbox RLS remains unchanged, including owner/admin reads.
Binding UUIDs/image digest are nonsensitive metadata; credentials/hashes remain
in the existing service-only host table.

## Defaults and remaining work

The actual existing default is DEFAULT_LAUNCH_TTL_SECONDS = 14,400 seconds (four
hours), also the SQL expiry default. It stays unchanged. Earlier Docker docs
saying 3,600 seconds were incorrect and are corrected, not used to change policy.
Host credential remains no-expiry/revocable; no disk quota, goldens, resume,
Hosts UI or gVisor in this milestone.

Still required: opt-in public Docker DTO/placement resolution, runtime authority
and ticket/configuration issuance, launch/read/prompt/stop/delete wiring and the
coordinator's final real-host SSH lifecycle check.

## Exact coordinator checks

No worker deployment, remote migration or real-host access was used. Locally:

```sh
bun test packages/core/test/docker-sandbox-schema.test.ts packages/core/test/database.test.ts
bun scripts/db/check-migrations.ts origin/main
```

Expect migrated-PGlite admission, identity/lifecycle/privacy denials, revoked-host
cleanup and legacy schema/provider tests to pass without sockets, Docker or sleeps.
Recheck migration ordering on fresh main before merge.

After normal coordinator **staging-only** migration, use securely configured
libpq environment variables (never database credentials in argv), then run:

```sh
psql -X -v ON_ERROR_STOP=1 <<'SQL'
select enumlabel from pg_enum
 where enumtypid='public.sandbox_provider'::regtype order by enumsortorder;
select conname,convalidated from pg_constraint
 where conrelid='public.sandboxes'::regclass
 and conname in ('sandboxes_docker_host_fk','sandboxes_golden_source_chk','sandboxes_docker_binding_chk')
 order by conname;
SQL
```

Expected providers boat/modal/docker; all three constraints present and validated.
This catalog check is not real Docker/Codex proof. Final SSH install/register/
one-prompt smoke remains the launch integration PR's obligation.
