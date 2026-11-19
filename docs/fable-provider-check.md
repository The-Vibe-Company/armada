# Fable provider gate (#1019)

## Investigation and availability

Armada's Boat adapter sends the exact model in the SDK prompt JSON. The native
cwd wrapper preserves argv. The captured first main API request already selected
Sonnet: no evidence establishes an Armada rewrite, entitlement failure or refusal
fallback. See [the investigation](model-selection-investigation.md) and its
unchanged recording. The remaining mapping boundary is upstream Boat; guessing a
native override would not establish fidelity. The Boat native prompt adapter refuses explicit Fable
before dispatch, including send overrides, with readable mismatch terminology.

Armada's shared Claude runtime passes the requested model into SDK query options
(packages/agent-runtime/src/claude.ts). This proves forwarding, not live execution.
With no staging Claude account, neither provider is newly advertised as
Fable-capable. The shared catalogue omits Fable until execution is established;
custom IDs remain available on Modal. No iPhone decoding or closed-list DTO change
is needed. Existing mismatch reporting remains unchanged for other models.

## Production check (coordinator only, after merge)

Use Claude Code 2.1.322 or newer and a ready snapshot for each provider in
the selected organization. Set `ORG_UUID` to that organization's UUID,
`CLAUDE_ACCOUNT_UUID` to the UUID of an entitled direct Claude account (a
standard Anthropic API key or Claude subscription), and
`BOAT_SNAPSHOT_NAME` and `MODAL_SNAPSHOT_NAME` to the corresponding snapshot
names. The Boat probe checks the native path. Confirm that the existing
deployment and selected account use that path before running it. In
`POST /api/v1/launch/options`, confirm `boatRuntime.defaultPath: "native"`
and `modalRuntime.defaultPath: "runtime"` on the target server.

```sh
armada launch "$BOAT_SNAPSHOT_NAME" --agent claude --provider boat --org "$ORG_UUID" --credential-id "$CLAUDE_ACCOUNT_UUID" --model claude-fable-5-2 "Reply with probe only. Do not use tools."
armada launch "$MODAL_SNAPSHOT_NAME" --agent claude --provider modal --org "$ORG_UUID" --credential-id "$CLAUDE_ACCOUNT_UUID" --model claude-fable-5-2 --json "Reply with probe only. Do not use tools."
```

The Boat native prompt must reject with the readable model_selection_mismatch
explanation. If launch allocated a sandbox, retain its failure ID. The Modal
JSON receipt must show `sandbox.runtimeTransport: "dialout"` and
`runtime.kind: "armada"`. Set `MODAL_SANDBOX_UUID` to the returned
`sandbox.id`, then run:

```sh
armada wait "$MODAL_SANDBOX_UUID" --timeout 300 --org "$ORG_UUID"
armada status "$MODAL_SANDBOX_UUID" --org "$ORG_UUID" --json
armada logs "$MODAL_SANDBOX_UUID" --all --org "$ORG_UUID" --json
armada stop "$MODAL_SANDBOX_UUID" --org "$ORG_UUID"
```

Require requested Fable, first main native request and completed root response
model claude-fable-5-2 (or its authoritative dated ID), and matching actual-model
evidence. Missing evidence is not a pass. Never infer identity from answer prose
or title/subagent models. A mismatch must retain the existing closed reason.
Always stop in failure paths too. If Boat allocated compute, set
`BOAT_SANDBOX_UUID` to the Armada UUID from the launch and run
`armada stop "$BOAT_SANDBOX_UUID" --org "$ORG_UUID"`. Record account kind, runtime version and redacted root
evidence, never credentials. No production action was performed during delivery.
