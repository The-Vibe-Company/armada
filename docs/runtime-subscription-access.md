# Epoch-fenced subscription access (#1161)

The Boat dial-out runtime can now obtain **access-only** Codex subscription
material through `POST /api/runtime/model-access`. No stable guest capability or
refresh token is delivered in this mode. This is not a model proxy: model
inference still runs directly through the native harness/provider connection.
The existing Modal/tunnel subscription path is unchanged.

## Authority and refresh

Requests use the runtime bearer plus `X-Armada-Runtime-Epoch`; body is only
`{previousRevision?}`, capped at 1 KiB. The server derives sandbox/owner/account
pin from the session and SQL, never caller IDs. Only active Codex subscriptions
already owned by the server are eligible. Ambient browser origins are refused.

The current epoch is checked before access. The existing subscription broker
owns OAuth refresh, serialization, encrypted state and lost-response recovery.
No sandbox/epoch lock is held across refresh/network I/O. Before delivery the
server reacquires member -> credential -> sandbox -> epoch authority, checks the
same active account/version/ownership and rejects stop, replacement or revoked
membership/pins. It projects only access token, account/plan and revision; no
broker additions/refresh material can escape. Every reply is `no-store`.

Runtime client verifies the response epoch and access shape. A 401/403 fences
its channel/native work; transient 503 does not permanently revoke the epoch.
The driver callback registers each access token for redaction **before** exposing
it to the child, and supplies the prior revision when native auth requests a
refresh. There is no blind network retry or second refresh implementation.

## Private startup selection

Canonical server-owned state plus an enabled broker now projects only
`runtimeSubscription:true` in encrypted configuration. No raw auth.json,
refresh-token redaction history or stable subscription capability is exported.
Absent broker/unowned marker still fails closed; native legacy publication and
API-key/custom-endpoint projections remain unchanged.

Compiled main admits this flag only for enrolled Codex, not credential-free
builders, raw auth, old stable capabilities or custom endpoint/key mixtures.
It uses the dial-out callback and existing native auth-file cleanup/redaction;
legacy Modal selection/callback is unchanged. No public launch switch is added.

## Coordinator check

No Boat starts, model calls, migrations or remote deployment needed:

```sh
bun test packages/mcp-server/test/runtime-native-auth.test.ts packages/mcp-server/test/boat-runtime-configuration.test.ts packages/agent-runtime/test/dialout.test.ts
```

Expected: real local migrated SQL + route + RuntimeDialout + driver callback
round-trip access-only material and revision intent; stop/epoch/membership/pin/
ownership replacement during refresh cannot return it. Unknown broker metadata
and private diagnostics are not reflected. In-memory upstream port avoids OAuth
or inference; existing broker and Codex native-driver tests own those contracts.

Before a future opt-in uses this mode, deploy the normal artifact-bearing Docker
image and select its matching compiled build manifest on the server (see
[publication](runtime-bootstrap-cache.md)); no separate publication is needed. No prerequisite changes for existing default/native/Modal launches.
Per-launch opt-in/durable routing and launch/startup/cleanup binding still remain
for ONE real Boat answer; its exact coordinator check will follow on #1161.
