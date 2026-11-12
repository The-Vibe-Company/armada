# ACP v1 driver (OpenCode slice 1, #1164)

`AcpDriver` implements the runtime Driver/Turn contract over newline-delimited
JSON-RPC. This slice is dormant: it does not advertise a third harness, change
SQL, alter credential resolution or start OpenCode on an existing launch.
The next stacked slice wires the catalog, model connection and Modal bootstrap.

## Verified dependency

Pin: official `opencode-ai@1.19.5`, Linux x64/arm64 native npm packages. The
runtime artifact build verifies the native executable against the checked-in
SHA-256 values in `src/opencode-artifact.ts` and records version/digest in its
manifest. Bun's lockfile also pins the npm tarball integrity. No mutable latest
version is used at build/launch. This pin supersedes unverified V2 package names
from early research; it was checked against the real npm registry.

Primary source inspected at tag v1.19.5:
- https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/acp/service.ts
- https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/acp/usage.ts
- https://opencode.ai/docs/cli/acp
- https://agentclientprotocol.com/protocol/v1/prompt-turn

A real Linux x64 `opencode acp` initialize probe returned protocolVersion 1,
agentInfo.version 1.19.5, loadSession and HTTP MCP capabilities. No model key or
model call was used. The pinned implementation exposes no private steer method;
steering therefore cancels and starts a continuation on the same session,
matching Armada's existing restart semantics rather than pretending native
injection is supported. Cancelled and continued usage is combined into the same
Armada prompt. Missing native counters remain unknown, not zero or estimated.
Only the harness's prompt-response usage is used, never context/cost snapshots.

## Transport and safety

Every turn opens a process, loads its saved native session when supplied, and
suppresses history replay before publishing current-turn output. Session identity
is checked before native resume is acknowledged. Model selection is explicit.
MCP is re-delivered on new/load. Permission requests can select only an explicit
one-shot allow option in the admitted sandbox; client filesystem/terminal RPCs
are not advertised. Diagnostics and raw RPC errors are never published. The
runtime's existing ChildOwner retains process-group ownership through cleanup.

## Checks

Fast deterministic boundary: `bun test packages/agent-runtime/test/acp.test.ts`.
It runs a real fake stdio child, covering load/replay, session filtering, prompt,
restart steering, interrupt, counters/unknown counters and protocol refusal.
`bun packages/agent-runtime/build.ts` validates the pinned executable digest.

Coordinator staging check for this dormant slice: build the runtime artifact on
Linux, verify `manifest.json.opencode.version` is `1.19.5`, and run its `opencode
acp` initialize handshake with protocolVersion 1. Expect protocolVersion 1 and
loadSession true. Existing Claude/Codex launch behavior must remain unchanged.
After the integration slice, coordinator runs the Modal lifecycle smoke with its
DeepSeek model connection: answer, follow-up, steer, interrupt, resume, events and
reported turn tokens. This slice does not claim real-provider acceptance.
