# Consolidation audit (#829)

Baseline: main on 2026-11-10. This is a bounded audit, not proof of deployed
conformance. No production/staging calls, migrations or deployments were made.
[State model](state-model.md) · [API errors](api-error-codes.md).

## Ranked findings / disposition

Three safe corrections are included here: preservation runtime requirements
(Python → Bun, failure label and ordinary-vs-parent idle policy); Boat continuation
and smoke capability documentation; AGENTS server entrypoint and obsolete
dependency snapshot claims. These are behavior-preserving documentation changes.
No uncertain test or legacy recovery branch is deleted merely for being old.
[#835](https://github.com/The-Vibe-Company/armada/issues/835) is deferred to keep
this audit documentation-only: replacing the literal is tiny, but proving the
adapter advertises the correct identity needs a protocol-boundary assertion, not
a source-text check. The three truth corrections above are the safe fixes chosen
for this PR; #835 can land independently without lifecycle or documentation work.

## Production failures versus offline proof

Paths below are relative to `packages/mcp-server/test/` unless specified.
They identify what the test boundary proves, not that a historical bug still exists.

## Smoke and CI boundaries

`.github/workflows/ci.yml` adds native runtime validation, actual process-boundary
checks, disposable PostgreSQL migrations and concurrency/integration checks.
`.github/workflows/post-deploy-smoke.yml` uses staging configuration and may
successfully no-op when configuration is absent. Green unit CI or a no-op smoke
is not the enabled-pair deployed quality bar. Coordinator-run staging evidence
must name the pairs actually exercised and confirm the full cycle.

## Dead code / state and diagnostics decisions

This audit found no safely proven unused recovery path to remove. Follow-ups
require evidence at the owning boundary, rather than a large speculative cleanup.
