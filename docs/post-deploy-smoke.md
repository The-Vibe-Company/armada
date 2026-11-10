# Deployed API smoke
 
> **Staging gate opt-in:** With repository variable STAGING_GATED_DEPLOYS=true,
> [Staging-gated production](releasing.md#staging-gated-production-owner-opt-in)
> owns staging migrations/deployment/smoke and production migrations/deployment
> from one SHA under a whole-pipeline lock. Independent automatic staging and
> production migration applies and deployment-event smoke below are disabled.
> Missing gate configuration blocks promotion, never counts as a green smoke.
> Manual history/repair/preview remain operator tools. Cutover, deliberately red
> smoke proof, emergency override and rollback are in that runbook.
> With the variable absent/false, legacy behavior below is unchanged.

`scripts/post-deploy-smoke.ts` allocates **real, billable compute**. It uses only
an Armada bearer token and the deployed server's `/api/v1/` API. It does not
deploy, apply migrations, or contact a provider/database directly.

## Configure staging

The GitHub environment **staging** uses the following exact configuration names.
Set these at environment scope, not to production values:

| Kind | Name | Purpose |
| --- | --- | --- |
| Variable | `ARMADA_ORIGIN` | `https://armada-mcp-staging.up.railway.app`; smoke API origin |
| Secret | `SUPABASE_PROJECT_ID` | Separate staging Supabase project reference; migrations only |
| Secret | `SUPABASE_DB_PASSWORD` | Staging database password; migrations only |
| Secret | `SUPABASE_ACCESS_TOKEN` | Supabase management token authorized for staging; migrations only |
| Secret | `ARMADA_SMOKE_TOKEN` | Staging Armada bearer token; smoke only |
| Secret | `ARMADA_SMOKE_CASES` | JSON array with staging org, golden and model account identifiers; smoke only |

The project reference, database password and origin variable are already configured.
The owner must still add the access token, smoke token and cases. Each job checks
its own required configuration and emits a clear no-op notice if any is missing.
Migration credentials are never passed to the smoke script.

Smoke-specific values:

| Secret | Value |
| --- | --- |
| `ARMADA_ORIGIN` (variable) | Explicit HTTPS origin of the staging Armada API (no path/query/userinfo); mapped to the script's `ARMADA_URL` |
| `ARMADA_SMOKE_TOKEN` | Armada token scoped to a dedicated smoke user/org with launch, interior access and stop permission |
| `ARMADA_SMOKE_CASES` | JSON array described below, including golden names/IDs and model account IDs |

No origin is supplied by default. Never put production credentials or a production
origin in the staging environment. Configure environment protection rules as
appropriate. The workflow does not accept a target origin input and never uses
the deployment payload's URL.

Example cases (replace placeholders; account IDs are identifiers, not credentials):

```json
[
  {
    "provider": "boat",
    "harness": "claude",
    "org": "<staging-org-id>",
    "golden": "<boat-golden-name>",
    "model": "<available-model>",
    "modelAccountId": "<claude-model-account-id>",
    "repo": "/home/user/armada"
  },
  {
    "provider": "modal",
    "harness": "codex",
    "org": "<staging-org-id>",
    "golden": "<modal-golden-name>",
    "goldenId": "<modal-golden-id>",
    "model": "<available-model>",
    "modelAccountId": "<codex-model-account-id>",
    "repo": "/home/user/armada"
  }
]
```

Each entry is an explicit provider × harness pair; add entries for every pair
you want to cover. Goldens must already exist for their provider and contain a
git checkout with an `origin` remote at `repo`. Configure the user's model
accounts and GitHub connection on staging beforehand. For private repositories,
the token's user must have access. No provider/database credentials belong in
this workflow.

## Staging migrations

The **Database migrations** workflow runs an independent `Staging migrations`
job on main pushes that change `supabase/migrations/**`, and on main manual
dispatches with `mode=migrate`. It uses the separate staging project, links it,
lists applied versions, previews with `supabase db push --linked --dry-run`, then
applies pending migrations with `--yes` on push or when manual `dry_run=false`.
Manual dispatch defaults to preview-only. History/repair remain production-only.

All three `SUPABASE_*` secrets above are required before checkout, CLI setup or
any database connection. Missing configuration produces notices and successful
no-op completion. Staging has its own concurrency group and no dependency on or
from production, so missing staging secrets cannot block production. Production
conditions, commands and release-synchronized behavior are unchanged.

Railway's `staging` environment auto-deploys main and has its own database and
encryption key. This migration job is independent of that deployment; it does
not provide a schema-before-deploy gate. Continue to use additive, compatible
migrations. The workflow does not deploy the server or configure Railway.

## Run

From a trusted checkout with Bun installed, set environment variables without
putting the token in shell history or command arguments:

```sh
export ARMADA_URL='https://armada-mcp-staging.up.railway.app'
read -rs ARMADA_TOKEN; export ARMADA_TOKEN; echo
export ARMADA_SMOKE_CASES="$(cat /path/to/staging-cases.json)"
export ARMADA_SMOKE=create_real_compute
bun scripts/post-deploy-smoke.ts
# Optional; use only pairs supported by orchestrator capabilities:
bun scripts/post-deploy-smoke.ts --orchestrator
unset ARMADA_TOKEN
```

The normal path launches each case, sends one trivial prompt, waits for success,
checks `git status -sb` and `git ls-remote origin HEAD` in the checkout, stops
the sandbox and checks provider state. The optional path also exercises
orchestrator create → send → stop → resume → stop. It requires `goldenId`;
currently the orchestrator supports Modal/Codex only. Use a separate cases file
containing only supported pairs for that run.

The **Post-deploy smoke** workflow can be dispatched on main. It also runs after
a successful GitHub `deployment_status` for environment exactly `armada / staging`
(Railway's GitHub deployment name, not the GitHub secrets environment). To
override the accepted name, set the repository variable
`ARMADA_SMOKE_DEPLOYMENT_ENVIRONMENT` to the exact staging deployment name.
Leave it unset or empty to use the default; never set it to a production name.
Use repository scope: environment-scoped variables are unavailable when GitHub
evaluates the job's `if` condition, before the `staging` environment is attached.
Your deployment system must publish that GitHub status; a Railway/Vercel deploy
alone is not assumed to produce it. It uses reviewed main code, not arbitrary
deployment refs. Missing any required secret produces a notice and makes no
API calls. Production/preview deployment events are ignored. Runs are serialized
and not cancelled by a newer deploy, allowing cleanup to finish.

Each step emits a fixed diagnostic line; failures exit nonzero. API bodies,
command output, tokens and provider error messages are never printed. Requests
and polling are bounded, and cleanup runs even after a failed step. This is
a smoke test, not a resource janitor: a killed runner or an ambiguous create
response can still require operator reconciliation in the staging dashboard.
Do not blindly rerun a timed-out create. Stopped resources retain provider disks
according to the normal retention policy; this smoke does not delete goldens or
unrelated resources.

## Offline validation

```sh
bun test scripts/post-deploy-smoke.test.ts
```

Tests drive the real step logic through a fake API and virtual polling clock;
they require no credentials, network calls, compute or wall-clock waits.
