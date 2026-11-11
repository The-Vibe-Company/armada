# Deployed API smoke

> **Release-only production gate:** With repository variables
> RELEASE_SYNCED_DEPLOYS=true and STAGING_GATED_DEPLOYS=true,
> [Staging-gated releases](releasing.md#staging-gated-releases-owner-opt-in)
> continuously deploy/migrate/smoke main on staging. Release calls that same staging
> workflow for its exact validated SHA before production migrations/server/dashboard/npm.
> Independent automatic migration applies and deployment-event smoke below are disabled.
> Manual diagnostic smoke/history/repair/preview remain available. Missing gate config
> blocks promotion. Owner cutover, emergency bypass and rollback are in the runbook.
> Manual diagnostic smoke has a separate lock: wait for pinned staging deployment/
> smoke to finish and ensure no next deployment is queued before running it.
> It can otherwise observe staging mid-deploy and never authorizes a release.
> With both variables absent/false, legacy behavior below is unchanged.

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
orchestrator capabilities must enable the selected pair (Modal/Codex native or
Boat/Claude and Boat/Codex best-effort). Within that supported set,
the smoke reads `orchestrators/capabilities` once and validates every selected
pair before **any** sandbox or orchestrator allocation. A disabled or absent
pair fails the run; it is never silently skipped. Use a separate cases file
containing only enabled pairs for that run. Ordinary-only runs do not use this
orchestrator capability gate. Ordinary-pair preflight is tracked in
[#859](https://github.com/The-Vibe-Company/armada/issues/859): add an authenticated
`sandbox/capabilities` route using launch's provider/harness availability policy
and caller-visible model-account validation, then gate ordinary cases before
allocation. Orchestrator enablement is a separate policy and cannot substitute
for that route.

### Pair prerequisites

All four rows use the same GitHub **staging** environment variable
`ARMADA_ORIGIN` and secrets `ARMADA_SMOKE_TOKEN` and `ARMADA_SMOKE_CASES`.
These are shared across the matrix, not one secret per pair. Provider keys and
model credentials live in Armada's staging credential store, not GitHub Actions.

| Pair | Staging resources | Fields in each `ARMADA_SMOKE_CASES` entry | GitHub staging configuration |
| --- | --- | --- | --- |
| Boat × Claude | Boat golden with git checkout; Claude model account available to smoke user | `provider: "boat"`, `harness: "claude"`; `golden` = Boat golden name; `goldenId` = same Boat golden's ID for orchestrator runs; `modelAccountId` = Claude account ID; `model` = model supported by that account | Shared `ARMADA_ORIGIN`, `ARMADA_SMOKE_TOKEN`, `ARMADA_SMOKE_CASES`; no pair-specific GitHub key |
| Boat × Codex | Same staging Boat account/key and reusable Boat golden; Codex model account available to smoke user | `provider: "boat"`, `harness: "codex"`; `golden` = Boat golden name; `goldenId` = same Boat golden's ID for orchestrator runs; `modelAccountId` = Codex account ID; `model` = model supported by that account | Same shared variable/secrets; no pair-specific GitHub key |
| Modal × Claude | Modal golden with git checkout; Claude model account available to smoke user | `provider: "modal"`, `harness: "claude"`; `golden` = Modal golden name; `goldenId` = same Modal golden's ID for orchestrator runs; `modelAccountId` = Claude account ID; `model` = model supported by that account | Same shared variable/secrets; no pair-specific GitHub key |
| Modal × Codex | Reusable Modal golden; Codex model account available to smoke user | `provider: "modal"`, `harness: "codex"`; `golden` = Modal golden name; `goldenId` = same Modal golden's ID for orchestrator runs; `modelAccountId` = Codex account ID; `model` = model supported by that account | Same shared variable/secrets; no pair-specific GitHub key |

Every entry also requires `org` (staging org ID) and `repo` (absolute path to
that golden's git checkout with an accessible `origin`); `reasoningEffort`
is optional. The smoke token's user needs access to those resources and a staging
GitHub connection authorized for the checkout. `goldenId` is currently required
only with `--orchestrator`; use the same provider's golden, not another provider's
ID. Account references are per harness and may be reused across providers when
the account supports both; they are identifiers, never credential values.

Goldens are provider-specific: a Boat golden cannot stand in for a Modal golden.
Use a **separate Boat account and account key for staging**, shared by both Boat
harness rows (not a separate Boat key per pair): Boat allows one golden per
account. Configure that key in Armada's staging credential store, never in the
cases file or workflow. For orchestrator runs, every selected pair must also be
enabled on the staging server and reported enabled by its capabilities endpoint.
A server-wide disabled switch reports `orchestrator_disabled`; an absent or
disabled selected pair reports `pair_disabled`.
These prerequisites do not imply a pair is enabled today.

This first matrix slice adds preflight only. Sandbox resume/recall,
orchestrator post-resume recall, bounded recovery/terminal-state assertions,
timings/job summaries and expanded closed failure labels remain follow-up work
in [#826](https://github.com/The-Vibe-Company/armada/issues/826) and
[#827](https://github.com/The-Vibe-Company/armada/issues/827). Before those full-cycle
changes are merge-ready, the coordinator must run the staging workflow with
`--orchestrator` and every enabled pair and return its receipts.

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

### Managed GitHub runtime mode

`bun scripts/post-deploy-smoke.ts --github-runtime` runs the staging-only native
Git/push slice. It additionally requires each case's `disposableRepository` field
(an exact credential-free HTTPS GitHub `.git` origin), all four provider/harness
pairs, gate/revision assertions and disposable push authority. See the
[settings, manual renewal and provider-specific broker procedures](github-runtime.md#automated-first-slice-822).
First run the default smoke above with the staging gate off for the stock baseline;
then retire those workers and turn staging on before running the new mode. A zero
exit from this partial slice does not authorize production enablement.

### Work-preservation slice (#969)

Both staging workflow entrypoints now pass `--work-preservation`. This mode
refuses any origin other than `https://armada-mcp-staging.up.railway.app` before
making requests. The existing case format is unchanged: every selected pair runs
twice, using separate disposable sandboxes. The first must start clean with no
local-only refs and stop without a preservation note or recovery archive. The
second creates a single empty, unpushed commit (no remote push), stops, retrieves
the same recovery endpoint used by `armada recovery`, and checks the in-memory
tar manifest for that exact commit. The selected bundle pack is indexed with Git
in a private temporary object store, then Git must read the expected commit
object. Incremental bundle prerequisite parents/trees need not be present; this
is an object-payload check, not a full checkout/restore. The archive is capped at
3 MiB base64, Git subprocesses at 10 seconds each, and the temporary store is
removed in a finally block. No tar paths are extracted. Archive contents, commit
IDs and Git/provider output are never logged. The smoke runner now requires Git.

Named steps are `preservation_clean_checkout`, `preservation_commit`,
`preservation_clean_stop` and `preservation_archive`. Missing or mismatched
archives fail with `preservation_failed`; the existing stop and cleanup receipts
still confirm provider termination. Recovery is checked after stop/status so a
lifecycle capture overwriting the stop result cannot silently pass.

Budget: two allocations and two trivial model turns per selected pair, instead
of one. Expect roughly 4–10 minutes per pair (provider/model dependent); the
whole run remains capped at 35 minutes plus five minutes reserved for cleanup,
inside the 45-minute workflow limit. Four slow pairs can exhaust this budget and
fail closed. Cost is twice the baseline sandbox/model usage, plus small recovery
storage; stopped disks/archives retain the normal retention cost. No dollar
estimate is reliable without the configured provider/model rates. Do not run
this mode with production credentials. Live staging execution is performed by
the existing post-deploy workflows, not by a PR or offline test run.

Remaining #969 families (not claimed by this slice): full sandbox resume/expiry/
list consistency and timings/leftover summaries; GitHub refresh; vault; templates;
public/private skills and golden pinned digest verification. These are
verification follow-ups, not new product capabilities. Per the owner decision
on #969, orchestrators are excluded; their removal belongs to a separate ticket.

### Template and skill pins slice (#969)

The next staging slice exercises personal readable-variable templates and pinned
public/private skills on the explicitly selected provider × harness cases when
the corresponding exact pins are configured.
Orchestrators are excluded. A random disposable value must be read by the native
agent (not included in the prompt), while a plain exec must not inherit its
environment binding. Installation receipts must match the requested exact pins.
Private installation is skipped only when Skillpack connection metadata confirms
no personal or matching-org key is configured; a configured but unusable key is
a failure. Template, variable and sandbox cleanup runs even after a failed check.

Both staging entrypoints pass `--templates-skills` in addition to
`--work-preservation`. The new mode also refuses any origin other than the exact
staging API origin before requests. It can be run independently with:

```sh
bun scripts/post-deploy-smoke.ts --templates-skills
```

For this mode every case additionally requires `goldenId`. Optional `publicSkill`
(`org/slug@exact-version`) and `privateSkill` (`slug@exact-version`) enable their
individual install checks. Omit either pin to emit an explicit
`skill_pin_not_configured` SKIP for that step, while the readable-variable template
launch, answer and exec-isolation checks still run. For example,
add `"publicSkill": "your-catalog/public-smoke@1.0.0"` and
`"privateSkill": "your-private-smoke@1.0.0"` to each existing case, using real
accessible pins. There are no default pins; malformed supplied pins fail configuration.
The selected `modelAccountId` is pinned to its current metadata version through
`creds/list`; no silent default-account substitution is used. The existing
`repo` remains the absolute exec cwd, not a template repository selector;
template launches use the golden's default native cwd.

Cases are the explicit enabled provider × harness matrix, as in the baseline.
There is still no ordinary sandbox capabilities API; a configured unsupported
pair fails rather than silently skipping. Keep the staging cases current.
The existing staging token needs readable-variable/template create/delete,
credential metadata, launch, interior access and stop permissions. Provider/model
keys and Skillpack keys remain in Armada's staging store, never in the cases.

Per pair, the first template carries the random variable, with a public pin only
when configured; a second template launch checks a configured private pin if a
key is available. Both the completed launch
manifest and sandbox status must carry matching receipts (reference, exact
version, skill ID, SHA-256 checksum and registry origin). The agent answer must
equal the random value exactly, and plain exec must see the variable as unset.
A private-key skip is a separate structured `skip: true` receipt, not a pass.

Budget: this adds one public and up to one private sandbox/model turn per pair,
roughly 3–8 minutes extra per pair depending on install/provider/model latency.
Combined with work preservation, expect three or four sandbox allocations and
model turns per pair, plus Skillpack install traffic; compute/model charges are
roughly three or four times the original one-worker baseline. The shared
35-minute work deadline and five-minute cleanup reserve are unchanged; slow
matrices fail closed rather than extending the run. Each new sandbox has a
15-minute TTL. Stopped disks and tombstoned metadata use normal retention.

Cleanup attempts every known sandbox, template and variable even if an earlier
cleanup fails. Lost variable/template create responses are reconciled by their
unique random names. An unknown launch response is never retried: without a
cleanup handle the run reports `cleanup_unconfirmed` and requires operator
reconciliation before rerunning. A final `template_cleanup_summary` reports
`leftoverSandboxIds` for failed stops and `uncertainLaunches` with the template
ID/name, exact durable launch request key and returned request ID when available.
These handles survive template deletion; never retry a launch with a new key to
reconcile it. Non-success launch receipts retain allowlisted `state`/`reason`
labels (including Skillpack transport/authorization and allocation uncertainty);
unknown remote text is replaced by `unrecognized_refusal`. This remains a smoke, not a resource janitor.
No live staging run or deployment is implied by the offline API tests.
