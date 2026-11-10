# Checkpoint quiescence (#732)

Deployment requires the server and rebuilt agent runtime from this revision. No database migration.

After deployment, use the API-only CLI (with an authenticated Armada session):

```sh
armada orchestrator detail c9110041-af53-4b62-ab45-e89beb1ff937
armada orchestrator recover 52b264fd-6a22-4dd7-91ba-1f9358aae7c2 --expected-revision 2 --idempotency-key recover-52b264fd-v2
```

Use the revision returned by detail for subsequent stop/resume operations, not a stale revision.
Do not manually delete the provider sandbox or modify SQL rows.
