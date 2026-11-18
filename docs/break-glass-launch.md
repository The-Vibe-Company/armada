# Launch workers during a production Armada outage

The release coordinator owns this runbook. Try the pinned CLI against staging
first. If the staging API works but its Modal placement cannot launch, use the
owner's Docker host registered on staging. If staging is unavailable or both
placements fail, run Codex locally.

## 1. Pin the previous CLI and launch on staging

In a dedicated Bash shell, enter the exact npm version from the last known-good
release before the incident. Use a staging org UUID, a staging Modal snapshot
name, and a compatible Codex account already configured in that org or in your
staging account. For private repositories, the staging org also needs its
[GitHub connection](github-app.md). Armada supplies the provider and model
credentials from staging.

```bash
read -r -p 'Previous known-good CLI version (X.Y.Z): ' cli_version
read -r -p 'Staging org UUID: ' staging_org
read -r -p 'Staging Modal snapshot name: ' staging_snapshot
break_glass_dir="$(mktemp -d)"
npm install --prefix "$break_glass_dir" --no-save --no-package-lock \
  "@the-vibe-company/armada@${cli_version}"
```

If installation fails, resolve it before continuing. The temporary install and
session directory keep the normal CLI and login intact. The wrapper clears any
inherited bearer and pins the staging API origin for every invocation. Sign in
with the GitHub account authorized in staging. Enter credentials only in the
browser.

```bash
staging_armada() {
  env -u ARMADA_TOKEN \
    ARMADA_URL=https://armada-mcp-staging.up.railway.app \
    XDG_CONFIG_HOME="$break_glass_dir/config" \
    "$break_glass_dir/node_modules/.bin/armada" --profile staging "$@"
}
staging_armada --version
staging_armada login --url https://armada-mcp-staging.up.railway.app --provider github
staging_armada org list
staging_armada snapshot list --org "$staging_org" --provider modal
staging_armada launch "$staging_snapshot" --org "$staging_org" --provider modal \
  --agent codex "Summarize the repository without changing any files."
```

Check that the version matches the pin and that the org and snapshot are visible
before launching. The prompt above is for the rehearsal. During an incident use
the repair task and include the assigned branch and acceptance criteria.

Use the launch response's sandbox ID for the commands below. Read the result
and confirm the task completed. If the launch response was lost, reconcile the
attempt in staging using the org, snapshot and start time before trying another
launch.

```bash
read -r -p 'Returned sandbox ID: ' sandbox_id
staging_armada status "$sandbox_id"
staging_armada logs "$sandbox_id" --follow
```

### Coordinator rehearsal record

Pending. The release coordinator runs path 1 once and replaces this line with
the UTC date, CLI version, placement and outcome. Confirm the worker answered
and was stopped. Keep tokens and account details out of the record.

## 2. Launch on the owner's Docker host through staging

Use the same staging wrapper and login. Staging must already allow Docker
placement and the owner must have registered an online host in that staging org.
The daemon uses its existing staging registration. Its credential stays on the
host. Staging supplies the Codex account and authorized repository access as in
path 1. See the [Docker host quickstart](own-machine-quickstart.md) for setup.

```bash
staging_armada host list --org "$staging_org" --json
read -r -p 'Owner staging Docker host UUID: ' staging_host
read -r -p 'Repository and ref (owner/repo@ref): ' worker_repo
staging_armada launch "Summarize the repository without changing any files." \
  --provider docker --host "$staging_host" --org "$staging_org" \
  --agent codex --repo "$worker_repo"
```

During an incident, substitute the repair task and the intended repository/ref.
Use the returned sandbox ID with the same status and logs commands. Check the
worker's result before handing it work. Reconcile uncertain launches using the
org, host and start time before retrying.

## 3. Run a local Codex worker

Use a trusted workstation with Git, the Codex CLI, access to the model through
your existing Codex login, and GitHub access through your usual Git credential
helper or SSH key. For a fresh Codex login, use its interactive sign-in. Keep
both logins on the workstation and use a separate checkout for the repair.

```bash
codex login status
# If signed out, run: codex login
git_dir="$(mktemp -d)"
git clone git@github.com:The-Vibe-Company/armada.git "$git_dir/armada"
cd "$git_dir/armada"
read -r -p 'Assigned repair branch: ' repair_branch
git switch --create "$repair_branch"
codex
```

If the assigned branch already exists remotely, use
`git switch --track "origin/$repair_branch"` in place of the create command.
In Codex, give the worker the issue, branch and verification requirements. Use
the workstation's normal approvals and Git access to review and publish the
work. This path needs neither an Armada session nor an Armada sandbox.

## Return to normal operation

Preserve repair commits on the assigned branch and hand off the PR or commit SHA.
For paths 1 and 2, stop each worker you launched and use status to confirm it
stopped. Once all workers are accounted for, sign out of the temporary staging
session and close the dedicated shell.

```bash
staging_armada stop "$sandbox_id"
staging_armada status "$sandbox_id"
staging_armada logout
```

For path 3, exit Codex after preserving the work. Once production is healthy,
resume the normal launch process with your usual CLI and production login from
your ordinary shell.
