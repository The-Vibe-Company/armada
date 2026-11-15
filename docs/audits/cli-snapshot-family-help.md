# Snapshot family discovery (#979)

Snapshot family help now shows a provider-aware command index instead of the
entire root CLI help. Both flags and the legacy golden spelling work before
authentication/I/O, using the user-facing name snapshot.

```sh
armada snapshot --help
armada golden -h
armada snapshot create --help
```

The index separates Boat/Modal operations, Docker get/rebuild/create, and shared
listing. It points users to existing focused leaf help rather than duplicating
every flag. No-argument invocation and operation parsing retain existing
behavior; the change applies only to explicit family help.

Offline run.ts audit: eight no-session/fake-token probes across both spellings
and both flags show broad root help before and focused family help afterward,
zero requests. No provider operation occurs. The issue's help-only audit
exemption applies; no staging/provider/TTY evidence or operation/permission
changes are claimed.
