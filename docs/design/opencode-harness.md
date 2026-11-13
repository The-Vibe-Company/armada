# OpenCode as the third harness

Design-only first PR for #1164 under #1160. The issue's **Binding design
decisions (2026-11-12)** override the earlier server/client proposal.
Status update (2026-11-12): the cleanup is complete and the coordinator released
ACP step 4 on Modal after verifying model connections/cost. Boat runs in parallel
and does not block OpenCode. Implementation and operator checks are documented
in `docs/runtime/acp-v1.md` and `docs/runtime/opencode-modal.md`.

## Current state

- `packages/core/src/harnesses.ts` owns IDs, models, credential kinds, native
  aliases and capabilities; existing exports are derived from it. iOS harness
  identity/labels/steering are generated and checked in CI.
- Codex and Claude retain their native runtime drivers. OpenCode uses one ACP v1
  transport and a native JSON export/import session adapter on Modal.
- The database harness/credential enums and private Modal binding support OpenCode.
  Named connection resolution remains sealed, owner-scoped and version-pinned.
- Boat still supports only its existing native harnesses. Its parity work and
  later removal of native runners are owned by #1161, not blocked on this ticket.

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

## Completed cleanup slice

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

## Step 4: released on Modal

The coordinator released OpenCode on Modal after verifying model connections and
cost in production. Boat steps run in parallel and do not block this work.
Implementation slices are a pinned ACP driver, private session/configuration
adapter, then catalog/connection/Modal launch integration. Each is independently
reviewable and stacked without waiting for its predecessor to merge.

The coordinator uses its DeepSeek key for the deployed lifecycle check in
`docs/runtime/opencode-modal.md`: launch, follow-up, active steer, interrupt,
stop/resume, events and per-turn tokens. Workers use only fake compatible endpoints.
The pinned real CLI was verified against a local fake streaming endpoint, including
export/checkpoint/import/resume; this does not claim a real deployed DeepSeek pass.

Docker hosts remain step 5 (#1165); Modal dial-out migration and tunnel removal
remain step 6. Interactive subscription login and real-plan-key validation are
not silently substituted for the API-key/custom-endpoint delivery in this slice.

## Later

ACP for all harnesses only when v2 is stable, steering standardized and adapters
vendor-maintained. Interactive subscription flows require terms verification;
extra provider quirks and multi-tenant hardening beyond current rules are deferred.
