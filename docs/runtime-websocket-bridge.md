# Runtime WebSocket command bridge (#1161, slice 7)

This slice adds server upgrades at `/api/runtime/channel`, using the existing
enrolment authority and durable command mailbox. Command bridge #1222 is merged,
so this PR is independent of open event-ingestion #1232 and is based on main.
No migration, Boat launch opt-in or Modal tunnel change is included. Events,
native-auth publication and full Boat lifecycle integration are separate work.

## Wire/lifetime contract

Only a GET WebSocket upgrade with Bearer runtime token and
`X-Armada-Runtime-Epoch` can connect. Query parameters are rejected. Initial
admission is checked against current membership/sandbox/epoch, with only token,
logical sandbox and epoch in private in-memory connection data. Cookies and
ambient user login do not authorize a connection. No token/payload is logged.

Client sends `{type:"ready",epoch}`, then `{type:"ping",epoch}` every 20s. Server
responds `{type:"pong",epoch}` under a fresh epoch fence. The 1 KiB inbound limit
is for these small control frames; commands/results are not accepted inbound on
WSS. Malformed, binary, repeated-ready or overlapping control frames close the
connection. Missing ready closes after 8s; missing client activity after 30s.
Bun native automatic pings are disabled so control checks remain authoritative.

After ready, the server rechecks the durable mailbox/authority every second.
`withNext` holds the existing member -> sandbox -> epoch fence through the
synchronous socket-send decision, never while awaiting network/ACK. At most one
unacknowledged command is sent per connection: its stable ID is not re-enqueued
each tick while a native RPC runs. Outbound frames are bounded at 1 MiB using
the already published `{type:"command",epoch,request}` contract; backpressure is
bounded too. Results still commit through HTTPS `/api/runtime/results` before
mailbox progress. A disconnect leaves unacknowledged work durable; the existing
client automatically falls back to HTTPS with the same epoch and request IDs.

A revoked/replaced epoch closes with 4401, including while native work is in
flight; the client's existing abort hook tears that work down. Transient backend
failure or server drain closes with 1012, allowing HTTPS fallback without a new
enrolment/version. Server shutdown cancels connection timers, rejects new
upgrades, and drains tracked admission/message/pump work before SQL closes.

The integration uses Bun's documented `server.upgrade` and `websocket` hooks:
[Bun WebSocket server documentation](https://bun.sh/docs/runtime/http/websockets).
The pinned Bun 1.4.2 native loopback proof exercised the production handlers,
not a protocol copy, with actual WSS and forced HTTPS fallback.

## Coordinator staging check

After deploying this server (no new migration), choose a disposable active Boat
sandbox owned by a current member. Never use a real worker: the diagnostic
replaces its runtime authority. Supply `ARMADA_STAGING_DATABASE_URL`,
`ARMADA_STAGING_ENCRYPTION_KEY`, `ARMADA_STAGING_URL` (HTTPS origin),
`ARMADA_STAGING_SANDBOX_ID` and `ARMADA_STAGING_OWNER_ID` through the secure
environment, never argv/logs. From the checkout with Bun/dependencies installed:

```sh
ARMADA_RUNTIME_SOCKET_SMOKE=use_disposable_staging_sandbox bun scripts/smoke-runtime-sockets.ts
```

Expected: the running server upgrades WSS, delivers one queued command, commits
its synthetic HTTP result/ACK, returns an authorized pong, then closes the old
epoch with 4401 after replacement. Only a fixed success/failure message is
printed. This is a **synthetic WSS/mailbox protocol** check, not a health RPC
executed by a native harness. Stop/delete the disposable sandbox afterward.

Worker proof additionally used a freshly compiled runtime against actual local
TLS/PostgreSQL16 production handlers: native PID health RPC over WSS with zero
HTTP polls, then forced disconnect and native PID health over HTTPS. No model or
host provider API was called; local fixture processes/files were cleaned up.
Real Boat Codex/Claude lifecycle, subscription refresh and cold/cache/resume
launch timing (>20% owner decision) remain for integration slices.
