# OpenCode as the third harness

Design-only first PR for #1164 under #1160. The issue's **Binding design
decisions (2026-11-12)** override the earlier server/client proposal.
No harness is enabled here. NOW scope: this realignment, then a separate
behavior-preserving one-harness-table cleanup. No ACP implementation yet.

## Current state

- `packages/core/src/contract.ts` defines `HARNESSES`; `models.ts` and
  `credentials.ts` separately define `MODEL_CATALOG` and `HARNESS_KINDS`.
- `packages/provider-boat/src/provider.ts` maps native Boat agents/capabilities;
  `packages/provider-modal/src/composed.ts` separately declares capabilities.
- `packages/agent-runtime/src/runtime.ts` hard-codes two drivers and validation;
  `claude.ts` and `codex.ts` implement `protocol.ts`'s Driver/Turn contract.
- The database harness enum, dashboard pickers and
  `apps/ios/Armada/Model/AgentValues.swift` also encode the two choices.
- Modal uses our runtime; Boat still uses its native runner. Neither gains
  OpenCode through this design or the cleanup slice.

## Binding target

Keep native Codex (`app-server`) and Claude Code (Agent SDK) drivers.
Use **one ACP v1 driver**, launching `opencode acp`, for OpenCode and later
ACP agents. Delete the alternative OpenCode V2 server/SDK integration plan;
there is no parallel server driver or ACP migration for the existing harnesses.

The host supplies a machine, not agent APIs. All prompt, steer, event, usage,
model, proxy and MCP behavior belongs to the Armada runtime. A golden remains
a recipe built per host. The shared host contract requires create, one command
with stdin, persistent storage, outbound HTTPS, stop/resume and delete;
snapshot, fork and human SSH are optional capabilities.

The runtime is one compiled executable per OS/arch (glibc by default).
Harness CLIs ship beside it, pinned by version and sha256 in a manifest;
fetch only the selected harness. Bootstrap checks digests and downloads missing
artifacts from Armada; warm images are caches. Support binary self-install
without a shell. Versions change only at start/resume, not mid-life.

The runtime dials out: WebSocket commands, automatic HTTPS long-poll fallback,
keep-alive under 30 seconds, acknowledged event batches from the local journal.
The host passes only a single-use enrolment token. Fetch configuration/model
credentials from the server at enrolment and every resume; each enrolment opens
an epoch, and the server rejects older epochs. Return refreshed subscription
tokens to the server, which remains their owner. Never put secrets in argv,
logs, repository files, goldens or API responses; keep them sealed at rest.
A proxy is only a model-connection address, not an Armada-hosted service.

Tokens come from the harness per turn; the server prices them (#1163).
Missing figures are unknown, never estimated. The coordinator reports that its
local ACP v1 spike passed steering, cancel, resume and per-turn tokens for
`opencode acp`; steered-turn usage merges into the running turn. This is owner
spike evidence, not a merged implementation or staging acceptance. Steering is
a private extension, not a standardized ACP guarantee. OpenCode V2 status,
nonzero cost and a real DeepSeek call remain unverified. The later driver PR
must record the tested CLI version/digest, configuration mapping and fixtures;
this design does not select an unproven V2 artifact or credential-store schema.

## NOW: independently mergeable cleanup

One browser-safe core descriptor table owns harness IDs and shared metadata.
Derive existing exports/validators instead of introducing a new list. Keep
server driver factories separate and preserve provider-specific capabilities,
model defaults, credential precedence, output and persisted values exactly.
Remove duplicate shared declarations; do not erase genuine provider differences.
Consumers, including iOS, must not require another hand-maintained harness list;
prefer a narrow generated artifact where cross-language derivation is needed.
Do not add OpenCode to the table, SQL enum, pickers or runtime in this slice.
No schema migration or new runtime/transport behavior belongs in the cleanup.

Each slice uses a fresh `origin/main` branch `codex/1164-<slug>` and `Refs #1164`.
Staging checks, run only by the coordinator after deploy:

1. **Design (this PR):** read this document against the binding issue decisions;
   expect ACP v1 only, no enabled OpenCode and no deployment prerequisites.
2. **Harness-table cleanup:** launch Claude and Codex on Modal with their current
   model connections; send a follow-up, interrupt, resume and inspect logs/usage.
   Expect unchanged selection, credential resolution, events and terminal status.
   Repeat on Boat using its then-current supported path; expect no behavior change.
   Locally run existing affected tests, typecheck and any generated-artifact check.

## Deferred: coordinator-gated order step 4

Do not start the ACP driver until the coordinator confirms order steps 1–3
passed the staging lifecycle smoke: Codex opt-in on Boat with compiled bootstrap,
dial-out/enrolment/epoch; Claude on Boat then default and native-runner removal;
model connections and session cost on Modal. #1161–#1163 own those steps.
Only then propose small ACP/launch/UI PRs, each with explicit staging checks.
Reuse the same driver across hosts; do not create a Boat-native OpenCode path.
Docker hosts follow at step 5 (#1165); Modal dial-out migration and tunnel removal
are step 6, not prerequisites to the NOW cleanup or work for this ticket.

Final OpenCode acceptance remains future: coordinator uses its owner-supplied
DeepSeek staging connection, runs launch/follow-up/steer/interrupt/resume/events
smoke on Modal, and observes an answer and reported per-turn tokens. Workers use
a fake compatible endpoint and never receive the owner's key. Adding the harness
must not introduce another hand-maintained harness list.

## Later

ACP for all harnesses only when v2 is stable, steering standardized and adapters
vendor-maintained. Interactive subscription flows require terms verification;
extra provider quirks and multi-tenant hardening beyond current rules are deferred.
