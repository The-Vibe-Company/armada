# Deployed API smoke

`scripts/post-deploy-smoke.ts` allocates **real, billable compute**. It uses only
an Armada bearer token and the deployed server's `/api/v1/` API. It does not
deploy, apply migrations, or contact a provider/database directly.

## Configure staging

Create a GitHub environment named **staging**, with these environment secrets:

| Secret | Value |
| --- | --- |
| `ARMADA_SMOKE_ORIGIN` | Explicit HTTPS origin of the staging Armada API (no path/query/userinfo) |
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

## Run

From a trusted checkout with Bun installed, set environment variables without
putting the token in shell history or command arguments:

```sh
export ARMADA_URL='https://your-staging-origin.example'
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
a successful GitHub `deployment_status` for environment exactly `staging`.
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
