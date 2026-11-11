# Fable provider gate (#1019)

## Investigation and availability

Armada's Boat adapter sends the exact model in the SDK prompt JSON. The native
cwd wrapper preserves argv. The captured first main API request already selected
Sonnet: no evidence establishes an Armada rewrite, entitlement failure or refusal
fallback. See [the investigation](model-selection-investigation.md) and its
unchanged recording. The remaining mapping boundary is upstream Boat; guessing a
native override would not establish fidelity. Boat now refuses explicit Fable
before provider work, including send overrides, with readable mismatch terminology.

Modal's native Claude adapter passes c.request.model into SDK query options
(packages/agent-runtime/src/claude.ts). This proves forwarding, not live execution.
With no staging Claude account, neither provider is newly advertised as
Fable-capable. The shared catalogue omits Fable until execution is established;
custom IDs remain available on Modal. No iPhone decoding or closed-list DTO change
is needed. Existing mismatch reporting remains unchanged for other models.

## Production check (coordinator only, after merge)

Use an entitled Claude account, a provider-specific accessible golden and Claude
Code 2.1.322 or newer. Replace golden placeholders. Run one launch per provider:

```sh
armada launch <boat-golden> --agent claude --provider boat --model claude-fable-5-2 "Reply with probe only. Do not use tools."
armada launch <modal-golden> --agent claude --provider modal --model claude-fable-5-2 "Reply with probe only. Do not use tools."
```

Boat must reject with the readable model_selection_mismatch explanation, without
dispatching a native turn. If launch allocated a sandbox, retain its failure ID.
For Modal, retain the returned sandbox ID and run:

```sh
armada wait <modal-id> --timeout 300
armada status <modal-id> --json
armada logs <modal-id> --all --json
armada stop <modal-id>
```

Require requested Fable, first main native request and completed root response
model claude-fable-5-2 (or its authoritative dated ID), and matching actual-model
evidence. Missing evidence is not a pass. Never infer identity from answer prose
or title/subagent models. A mismatch must retain the existing closed reason.
Always stop in failure paths too. Stop any allocated Boat sandbox with
`armada stop <boat-id>`. Record account kind, runtime version and redacted root
evidence, never credentials. No production action was performed during delivery.
