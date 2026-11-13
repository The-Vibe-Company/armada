# Enrolled Boat runtime: explicit GitHub access

This #1161 slice is opt-in Boat/Codex only. Native Boat and Modal keep their
existing routes and switches. MCP, cost and subscription acceptance are later slices.

An owner calls `github_refresh` (API `POST /api/v1/github/refresh`, `{ "id": "<sandbox UUID>" }`)
after the runtime is running. The server validates the owner's connected GitHub App
identity and sends a private durable `configureGitHub` command. No Boat prompt,
SSH, exec, boot-id lookup or host credential setup is used. Git identity and the
existing just-in-time Git/gh helpers are installed by the compiled runtime itself.
Credentials never appear in the public response, argv, files or journal.

Only repositories in the sandbox's golden are allowed. Each private token delivery
rechecks current membership, connection epoch, sandbox identity and live runtime
epoch; resolving GitHub outside the lock cannot authorize a stale final response.
Checkpoint intent, stop, disconnect and a new enrolment invalidate old authority.
Calling refresh again replaces the capability/revision; it does not enable a
persistent feature flag. **After resume, refresh again in the new epoch before
GitHub work.** Old wrappers are rebound to redaction-only IPC before native restore,
so local Git is usable without resurrecting old credentials.

`runtime_github_status` (API `POST /api/v1/github/runtime-status`, `{ "id": "…" }`)
returns owner-only, non-secret epoch/revision/configuration and successful private
credential delivery count. It does not probe GitHub. A count alone is not proof
that a GitHub operation succeeded; the staging check also requires its successful
command result in the Armada archive.

## Exact coordinator check: one allocation, two prompts

Prerequisites: apply `20261113060000_runtime_github_capabilities.sql` through normal
migration delivery before deploying the matching server/runtime image. Existing
GitHub App configuration and an owner connection must be valid; that connection
must have access to the selected repository. Normal images publish pinned artifacts;
there is **no manual artifact publication**. Keep the experimental Boat runtime
switch enabled. Do not run during a deployment.

From updated main, set the usual coordinator environment (`ARMADA_URL` = server
HTTPS origin, `ARMADA_TOKEN` environment-only, `ARMADA_RUNTIME_ORG` = organization
UUID, `ARMADA_RUNTIME_GOLDEN` = snapshotted Boat golden name,
`ARMADA_RUNTIME_CREDENTIAL_ID` = authorized Codex account UUID; optional model).
Choose a repository already in that golden and connected owner's scope:

```sh
ARMADA_RUNTIME_GITHUB_REPOSITORY=The-Vibe-Company/armada \
ARMADA_RUNTIME_SMOKE=one_real_boat_launch \
bun scripts/check-boat-runtime.ts --github
```

The script checks server capability and GitHub/golden access **before allocating**.
It makes ONE sandbox launch, no allocation retry. First prompt teaches a random
memory token; after explicit refresh, the same conversation runs read-only
`gh api repos/The-Vibe-Company/armada --jq .full_name` and recalls that token
without receiving it again. Pass requires exact assistant responses, finished
prompt events and a successful `commandExecution` tool result containing that
repository, all from `logs/read.source: "armada-runtime"`. It additionally requires
current `runtime.kind: "armada"`, matching epoch/revision and
`credentialRequests > 0` from the private broker status. Expect `github: "verified"`
and `githubProof` in safe JSON. The same sandbox is stopped once even on failure.
Optional `--checkpoint` adds sealed/stopped history readback without another start.
`--github --resume` is refused before allocation: that combined acceptance needs
explicit new-epoch setup and is not claimed by this check.

This does not prove GitHub access on staging until the coordinator runs it. It
creates no commits, PRs or other GitHub mutations. Existing milestone and follow-up
staging passes do not establish this additional GitHub behavior.
