# Failure triage and recovery

Start with `armada detail SANDBOX --json`, `armada status SANDBOX --json` and
`armada logs SANDBOX --tail 100 --json`. Save safe error codes, prompt ID and
provider identity, not secret-bearing output. Command exit success alone does
not establish a successful agent outcome.

- Authentication: confirm server and account. Ask for login renewal; do not
  repeatedly launch to test credentials. Missing org membership needs an admin.
- GitHub authorization: inspect connection/App access, reconnect if needed,
  then `armada github refresh SANDBOX`. Do not refresh unrelated credentials.
- Private skill failure: check exact pin, package authorization and the stored
  Skillpack credential. Do not retry with a public lookalike or silently omit the
  requested skill. A local installation is not proof remote launch can fetch it.
- Provider/capacity failure: inspect provider-specific golden availability and
  capabilities. Do not change provider or size without checking cost and intent.
- Unknown launch outcome: list your visible sandboxes and correlate returned IDs
  before creating another. For template launches, reuse the exact request key,
  resolved ID and body. For golden builds, inspect durable build status.
- Running but unresponsive: inspect logs, steer or interrupt deliberately. A
  transport timeout does not mean the agent stopped; avoid duplicate sends.
- Stopped/expired with unpushed work: do not delete. Record sandbox/provider IDs,
  repository/branch and last known SHA; ask the coordinator/provider-supported
  recovery path to preserve disk or recovery archive. This CLI does not expose
  general sandbox resume or archive extraction. Never label the work recovered
  until files/commits are accessible and pushed. A new golden launch is a new
  environment, not recovery of the old disk.

`armada exec SANDBOX "git status --short"` can inspect an accessible running
sandbox without starting an agent turn. Treat exec as arbitrary remote shell
execution: use authorized, non-destructive commands and do not print secrets.
`armada bind-credential SANDBOX --credential-id ACCOUNT --json` is owner-only
legacy Modal binding repair, requires a safe stop first, and does not restart
the machine. It is not general recovery. Escalate unsupported lifecycle actions
rather than inventing CLI flags.
