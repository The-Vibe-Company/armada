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
  repository/branch and last known SHA; inspect detail/status and the preservation
  note first. Modal retains disk only if checkpoint succeeds;
  checkpoint_failed_disk_not_retained means the disk was not retained and cannot
  resume. Do not promise recovery from that stopped machine.
- Retained stopped sandbox: with authorization, send one instruction, for example
  armada send SANDBOX "Inspect retained work, commit and push it, then report the SHA".
  This resumes the machine and continues the latest conversation by default; it
  starts a new turn and may incur cost. Current membership/access and model-account
  validity/version are checked; resume re-resolves current credentials, including
  GitHub access, rather than trusting stale secrets on disk. Repair rejected
  authorization through the supported login/credential flow before trying again.
  A credential rejection is not permission to bypass those gates.
- Ambiguous send: a timeout or transport failure may hide an accepted turn.
  Inspect detail, status and logs for the prompt/conversation and resulting work;
  do not blindly replay the instruction. Once running, verify accessible commits
  and a pushed branch/PR independently before claiming recovery or stopping again.
  A new golden launch is a new environment, not recovery of the old disk.

There is no standalone sandbox resume/recover command or general archive
extraction command. Escalate unsupported recovery paths rather than inventing
flags or calling undocumented endpoints.

`armada exec SANDBOX "git status --short"` can inspect an accessible running
sandbox without starting an agent turn. Treat exec as arbitrary remote shell
execution: use authorized, non-destructive commands and do not print secrets.
`armada bind-credential SANDBOX --credential-id ACCOUNT --json` is owner-only
legacy Modal binding repair, requires a safe stop first, and does not restart
the machine. It is not general recovery. Escalate unsupported lifecycle actions
rather than inventing CLI flags.
