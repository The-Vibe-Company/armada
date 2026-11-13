# Docker private runtime configuration (#1165)

This internal slice projects an already-authorized Docker account/target into
the same Codex runtime configuration used by Boat. It does not resolve accounts,
issue tickets, create sandboxes or enable a public Docker launch/provider API.

## Shared projection, no fake golden

The original boatRuntimeConfiguration import/signature remains a strict Boat
wrapper with its original error. runtimeConfiguration holds the single shared
projection and validates its explicit provider selector. Docker's wrapper uses
a minimal private target: logical identity, owner/org, Codex/private status,
expiry and credential pin, with no repository selection. No golden ID or Boat
compatibility alias is invented; the public provider choices remain unchanged.

Actor/target identity, active status/expiry, account ID/version, environment whitelist,
trusted Linux/glibc manifest and architecture checks remain shared. The existing
Boat test matrix owns API key/custom endpoint/subscription/native-state selection;
Docker adds its no-golden target and encrypted-delivery contract, not another
copy of that auth matrix. Cwd is /home/user for plain-image Docker.

The caller must resolve credentials through existing server policy, hold launch
admission and use the current persisted pin. Returned configuration is private:
pass it only to the opted-in runtime issuer for AES-GCM storage and the one-use
enrolment exchange. Give the host only artifact metadata plus the ticket, never
the full plan/configuration/model values. The returned cacheDir is the existing
guest bootstrap metadata, not permission to choose a host filesystem path.

## Defaults and remaining work

No launch default, host credential policy, Boat/Modal behavior, flag, route,
migration or harness implementation changes. Host credentials remain revocable
without expiry; no disk quota, goldens, resume, Hosts UI or gVisor.

Public placement/lifecycle orchestration, readiness/prompt/journal integration,
stop/delete and the final coordinator SSH install/register/one-prompt smoke remain
subsequent work. The helper does not authorize a host or claim runtime readiness.

## Exact coordinator check

No deployment, remote migration, Docker daemon, inference or sockets needed:

```sh
bun test packages/mcp-server/test/boat-runtime-configuration.test.ts packages/mcp-server/test/runtime-docker-authority.test.ts
```

Expect unchanged Boat auth selection/error checks plus a real migrated-SQL
credential resolution/pin and Docker configuration encrypted into pending
enrolment, delivered only to a valid owner/host-scoped runtime ticket. Repository,
provider, visibility, pin, unknown environment and selector escalation must
refuse before native-state reads and expose only fixed errors. No sleeps.
This is a configuration/protocol proof, not a real Docker/Codex lifecycle.
