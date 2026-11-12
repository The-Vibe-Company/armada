# Runtime dial-out client (#1161, slice 4)

This slice adds an explicit `armada-runtime dialout` mode. It is not yet a Boat
launch switch: the durable command/event bridge and Boat launch integration are
subsequent slices. No server endpoints are enabled by this PR, no migration is
included, and Modal's existing bootstrap/listener/tunnel stays unchanged.

## Bootstrap and lifetime

Private stdin carries only `{serverUrl, enrolmentToken}`: a non-secret HTTPS
origin and the single-use capability. Model configuration/credentials are fetched
from `/api/runtime/enrol`, never supplied through the host's feature API or argv.
The exchange is attempted once; a lost response needs a new trusted issuance.
The response must contain `{sandboxId,epoch,runtimeToken,configuration}`. The
configuration uses the existing native bootstrap shape, with `grant.expiresAt`;
the client overrides grant token, sandbox identity and generation from the
exchange. Port/ingest URL are not used for dial-out control or event upload.

The subsequent [enrolled bootstrap](runtime-enrolled-bootstrap.md) requires
`selectedHarness: "codex"` plus the compiled `artifactManifest` in that server
configuration and installs/verifies the selected CLI before command readiness.
Only the selected harness is admitted; image-provided CLI paths are ignored.

The epoch is immutable for the process. No reconnect or fallback re-enrols or
changes the binary/configuration. Start/resume must obtain a fresh ticket. A
401/403, stale frame epoch or revoked socket closes control and native drivers;
it is not treated as permission to retry with a new identity. SIGINT/SIGTERM
close native drivers too. Teardown starts on abort before waiting for an
in-flight native RPC, so resume/steer cannot defer revocation until their own
timeout. There is no inbound TCP runner listener in this mode.
Initial dial-out exec is explicitly refused: detached shell ownership/termination
belongs to the exec parity slice. Other commands use the existing Runner handler.

## Private channel contract for the server bridge

All requests are fixed-origin HTTPS/WSS, with Bearer `runtimeToken` and
`X-Armada-Runtime-Epoch`. Credentials are headers, never query parameters. HTTP
redirects/cookies are refused. Bun's native WebSocket custom-header constructor
is documented in [Bun's WebSocket documentation](https://bun.sh/docs/runtime/http/websockets).
A native Bun 1.4.2 loopback spike also confirmed that upgrade redirects were not
followed; the pinned version is retained.

- `/api/runtime/channel`: WebSocket, with an eight-second connect deadline.
  Client sends `{type:"ready",epoch}` and `{type:"ping",epoch}` every 20 seconds;
  server replies `{type:"pong",epoch}` under a current epoch check. Missing pong
  on the next heartbeat, a denied upgrade, an error or disconnect switches this
  process permanently to HTTPS. Revocation close codes are 4401/4403.
- Server commands are `{type:"command",epoch,request:RunnerRequest}`. Frames are
  capped at 1 MiB and 16 queued commands. Local dispatch is serial. Wrong epoch
  is fatal; invalid/overfull frames close the socket and fall back without
  dispatching those frames.
- `POST /api/runtime/poll`: body `{epoch}`, response `{epoch,command}` where
  command is a RunnerRequest or null. Server should hold an empty poll ~20s;
  client requests time out at 25s and idle polls have a 1s minimum delay.
- `POST /api/runtime/results`: `{epoch,requestId,status,body}`. Response must be
  `{epoch,requestId}`. A pending result is retried **before** another poll and
  is not discarded on a lost/malformed ACK. Server must redeliver unacknowledged
  commands after restart with the same requestId; Runner's durable receipt/fence
  prevents duplicate turns. A crash can still yield `request_outcome_unknown`;
  the bridge must not hide that by assigning a fresh ID.
- `POST /api/runtime/events`: existing `{sandboxId,generation,events}` batch,
  where generation is the epoch. The existing Journal/Runner owns sequence ACK
  validation/advancement. Native auth publications also use this endpoint with
  the existing `nativeAuth` envelope/receipt. The server remains credential owner.

## Coordinator staging check

On isolated staging Linux with pinned Bun 1.4.2 and `openssl` available, run:

```sh
ARMADA_DIALOUT_SMOKE=local_native bun scripts/smoke-runtime-dialout.ts
ARMADA_DIALOUT_SMOKE=local_native bun scripts/smoke-runtime-dialout.ts --http-only
```

Expected: freshly compiled runtime exchanges a one-use ticket with a private
loopback TLS fixture and executes real Runner health RPCs, first over WSS then
HTTPS, and separately after a rejected upgrade. Both print a fixed success
message and terminate cleanly. Ephemeral TLS private keys stay in memory; only
public CA certificates touch disk. Temporary processes/files are removed. No
model call, host compute, staging credentials or remote deployment is involved.
This is a **client-only** proof, not a claim that the deployed bridge or Boat
lifecycle works yet. Once bridge/launch wiring lands, run the real staging
lifecycle and cold/cache/resume timing comparisons, including the >20% threshold.
