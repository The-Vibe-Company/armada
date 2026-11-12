# Private Boat runtime launch configuration (#1161)

`packages/mcp-server/src/boat-runtime-configuration.ts` projects an **already
authorized** launch/account pin into the configuration encrypted enrolment needs.
It is internal, not a public DTO or credential/account resolver. It does not add
a launch opt-in or change native Boat or Modal behavior.

The caller supplies its authenticated actor, persisted Boat Codex sandbox/account
binding, existing `launchCredentials` result, trusted compiled build manifest,
explicit host architecture and existing model-auth ownership service. The
projector checks binding identity/version, owner/org, active logical expiry,
provider/harness and a single-segment repository directory. It never reselects
an account or falls back to org defaults. Live membership/account authorization
and lifecycle admission remain with the existing launch owner/resolvers.

The result contains public `artifact` digest/size and `cacheDir`, plus sensitive
`configuration` that must go **only** to `createRuntimeEnrolments.issue` (or the
startup service), never into a user response, log, provider fork environment or
host bootstrap payload. Its root is private and per logical sandbox. The
configuration supplies only logical expiry; enrolment replaces grant identity,
epoch and token. Selected-harness installation replaces the empty executable
placeholder before any driver can start. Claude receives no credentials/path.

- API keys reach only Codex's environment. Custom Responses endpoints are
  normalized with the shared parser, never converted to a hosted proxy.
- Server-owned subscriptions with an enabled broker select only
  `runtimeSubscription:true`; access-only material is fetched through the
  epoch-fenced runtime route, never a stable capability or raw refresh-token
  file. An absent broker or unowned server marker remains refused. See
  `docs/runtime-subscription-access.md`.
- Legacy native auth uses the ownership service's current sealed state/revision
  (initial auth only when no state exists), preserving current-epoch publication
  and retired-secret redaction. Unmanaged auth or an unenrolled server marker is
  refused rather than silently issuing a stale login.
- Unknown/unselected environment keys and mixed credential modes fail closed.
  Private parsing/native-state errors produce fixed diagnostics.

Manifest metadata is copied at projection time and target Linux/glibc/architecture
and runtime digest/size are checked. This accepts only trusted server-selected
build manifests, never client submissions. Full selected-harness archive/file
inventory verification remains with the existing installer/build smoke; this
projector is not a second artifact verifier or a hardware compatibility proof.
It neither downloads artifacts nor reads files or calls model/provider APIs.

## Coordinator check

No deployment, migration, model call or Boat start required:

```sh
bun test packages/mcp-server/test/boat-runtime-configuration.test.ts
```

Expected: API key/custom endpoint, fresh/rotated native auth
configurations project only the selected authority; mismatched
bindings, unsafe cwd/target, unknown secrets and unavailable native authority
fail closed. Tests use in-memory ownership ports; existing model-auth tests own
SQL authorization/refresh correctness. Both target architecture metadata and
empty/repository cwd cases are covered without claiming native execution.

Still needed for ONE real Boat prompt: wire configuration/startup/agent ports
into a per-launch default-off switch with durable routing and existing lifecycle
cleanup. The exact one-launch coordinator check will be posted on #1161 when
main supports it. No new deployment prerequisite until that integration enables
server-selected, published pinned artifacts.
