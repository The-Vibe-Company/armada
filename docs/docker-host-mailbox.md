# Docker host registration/mailbox (#1165, slice 3b)

Internal service only, stacked on the machine executor. There is no mounted
host route, binary installer or enabled Docker placement in this PR.
Existing Boat/Modal behavior is unchanged. No model credential or harness
operation belongs in the machine mailbox.

An organization admin issues a five-minute single-use registration capability.
Exchange binds it to one installation ID and yields a host credential. Hashes
only are persisted. The host credential has no expiry but can be revoked; the
issuer must remain a member for host operations. Host identity and installation
binding cannot be supplied to redirect another host's jobs.

Machine jobs are durable and redelivered with the original request ID until
completion. Changed content under the same ID refuses. The job payload is
AES-GCM sealed using ARMADA_ENCRYPTION_KEY; only fixed machine outcomes are
accepted back, not arbitrary CLI output. RLS and privilege revocation keep
hashes and ciphertext inaccessible to user JWTs.

Defaults for later launch integration: 3,600-second default launch TTL (as existing launches),
no disk quota yet. No resume, goldens, Hosts UI or gVisor. Registration exchange
and bootstrap jobs will be mounted only behind explicit opt-in in later PRs.

## Exact coordinator check

No deploy, real-host access, model call or network needed for this internal slice:

```sh
bun test packages/mcp-server/test/docker-host-store.test.ts
bun scripts/db/check-migrations.ts origin/main
```

Expected: disposable migrated PGlite proves admin authorization, one-use exchange,
host/installation isolation, revocation/membership checks, durable redelivery and
immutable completion. Migration guard accepts the new version. Recheck against
fresh main before merge; no worker applied a remote migration. Only deploy this
schema through the normal coordinator process when a later opt-in route needs it.
The final integration PR supplies the real-host install/register/launch commands.
