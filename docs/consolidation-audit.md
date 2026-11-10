# Consolidation audit (#829)

Baseline: main on 2026-11-10. This is a bounded audit, not proof of deployed
conformance. No production/staging calls, migrations or deployments were made.
[State model](state-model.md) · [API errors](api-error-codes.md).

## Ranked findings / disposition

| Risk | Finding / next reviewable PR |
| --- | --- |
| High | [#832](https://github.com/The-Vibe-Company/armada/issues/832): ordinary staging smoke lacks resume/second stop, unlike the quality bar. |
| Medium | [#833](https://github.com/The-Vibe-Company/armada/issues/833): direct/provider and shared-tool HTTP mappings disagree. Pin contracts before normalization. |
| Low | [#834](https://github.com/The-Vibe-Company/armada/issues/834): historical delivery narratives remain in orchestrator guides. |
| Low | [#835](https://github.com/The-Vibe-Company/armada/issues/835): HTTP-to-MCP adapter hardcodes server version 2.0.2 instead of shared VERSION. |

Three safe corrections are included here: preservation runtime requirements
(Python → Bun, failure label and ordinary-vs-parent idle policy); Boat continuation
and smoke capability documentation; AGENTS server entrypoint and obsolete
dependency snapshot claims. These are behavior-preserving documentation changes.
No uncertain test or legacy recovery branch is deleted merely for being old.

## Production failures versus offline proof

Paths below are relative to `packages/mcp-server/test/` unless specified.
They identify what the test boundary proves, not that a historical bug still exists.

| Reports | Current offline owner / limit |
| --- | --- |
| #717 | `serve-orchestrators-http.test.ts` launches real serve wiring in an isolated child; its SQL/provider/auth transports are fixtures, not deployed enablement evidence. |
| #728, #730 | `orchestrator-modal-native.integration.ts` explicitly uses fake native I/O; it proves SQL publication/fencing, not a Modal checkpoint or real boot. |
| #732 | `packages/provider-modal/test/checkpoint-process-conformance.ts` runs real process isolation in CI (both ordinary and native-pidfd modes). This is stronger than fake scrub success, but not the real provider image with all golden services. |
| #763 | `orchestrator-boat-best-effort.test.ts` covers the adapter policy; `serve-boat-orchestrators.test.ts` covers real serve composition with SDK HTTP/SSH fakes. Neither runs a billed turn. |
| #776 | `sandbox-lifecycle.test.ts` covers leased reconciliation; `work-preservation.test.ts` covers encrypted receipts/auth with fake exec; core collector tests cover local reconstruction. None alone proves Modal launch/send/stop through deployed serve. |
| #779 | `orchestrator-boat-sdk.test.ts` owns actual SDK request shape over fake transport; the serve Boat fixture protects composition. Keep both: different boundaries, not duplicates. |
| #785 | `orchestrator-boat-recovery.test.ts` and best-effort tests protect recovery/continuation policy with fake provider responses. Only deployed Boat/Claude can prove the retained conversation actually continues. |

`serve-orchestrators-http.test.ts` also asserts exact allocation/termination/epoch
counts. These are coupled to a multi-scenario fixture, but count ceilings protect
against duplicate billable effects. Do not delete them without retaining
per-scenario single-dispatch proof. No deletion met that evidence bar in this slice.

## Smoke and CI boundaries

`scripts/post-deploy-smoke.ts` ordinary path checks launch, one completed turn,
git access, preservation/stop and provider state. Its orchestrator option checks
create/send/stop/resume/stop. Cases are explicit, not an automatically exhaustive
provider × harness matrix. Offline script tests use a fake API/virtual clock;
they prove sequencing/cleanup, not readiness of any real provider.

`.github/workflows/ci.yml` adds native runtime validation, actual process-boundary
checks, disposable PostgreSQL migrations and concurrency/integration checks.
`.github/workflows/post-deploy-smoke.yml` uses staging configuration and may
successfully no-op when configuration is absent. Green unit CI or a no-op smoke
is not the enabled-pair deployed quality bar. Coordinator-run staging evidence
must name the pairs actually exercised and confirm the full cycle.

## Dead code / state and diagnostics decisions

- `orchestrator-boat-recovery.ts` explicitly recognizes old failed-resume receipts
  carrying boat_conversation_unavailable. Historical failures #730/#732/#785
  show why row-shape compatibility matters. Repository inspection cannot prove
  those rows no longer exist; retain the branch until an authorized data audit.
- `orchestrator-diagnostics.ts` retains the same closed label for runtime
  diagnosis. A label present in old logs is not evidence it is dead today.
- `ARMADA_ORCHESTRATOR_PAIRS` is still the supported opt-in/rollback boundary in
  serve/runtime; do not remove it as a stale feature flag.
- Parent and ordinary stop policies intentionally differ (native checkpoint
  versus best-effort preservation). Consolidating them would change behavior.
- State disagreement/blocked exits are enumerated in the state model; no generic
  reset or SQL repair is proposed. Error-table duplication is tracked in #833.

This audit found no safely proven unused recovery path to remove. Follow-ups
require evidence at the owning boundary, rather than a large speculative cleanup.
