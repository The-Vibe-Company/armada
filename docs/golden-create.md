# Secure, server-orchestrated goldens

Goldens contain repositories, dependencies and non-secret configuration, **never secrets**.
The CLI is an authenticated Armada API client: create, update, connect and snapshot all go
through the server's authorization and provider routing. Callers need an Armada session
(`armada login`) or `ARMADA_TOKEN`, and the appropriate `ARMADA_URL`, not provider keys.
Connect is for non-secret maintenance, not for installing credentials or secret-bearing files.

## Create or rebuild with the CLI

```sh
armada golden create web --repo https://github.com/acme/web --provider boat --org <org> \
  --idempotency-key <saved-key> --timeout 60
armada golden update web --config golden.json --provider boat --org <org> \
  --idempotency-key <new-saved-key> --timeout 60
```

- Create/update accept repeated `--repo <url>[@branch]` or `--config <file>`. Repeated
  `--init <cmd>` is supported with `--repo`, not `--config`; put init commands in the
  config file when using that form. `--setup <local-file>` reads a local script and sends its **contents** to run
  after cloning, before scanning. Do not put credentials in config, init or setup.
- Create defaults to org visibility; `--private` makes it owner-only. Org mutations require an
  admin; private mutations require their owner. Update retains the existing owner/visibility.
- Create defaults to `boat`; `--provider modal` selects a separately configured Modal target.
  Each golden is built separately per provider. For existing names on both providers, select
  `--provider` explicitly. Update uses the stored provider/account binding, not a migration
  between providers; Modal's workspace/environment/App binding is immutable. Boat compatibility
  IDs are not Modal IDs.
- Save an idempotency key **before submission** (16–128 letters, digits, underscores or hyphens).
  The CLI generates and prints one to stderr if omitted. It prints the admitted job ID, then
  polls. `--timeout` is a local wait in seconds, 0–600 (default 60), not the build deadline;
  `0` returns after admission. Acceptance or a successful exit after local waiting is **not
  publication**. Only `state: succeeded` establishes completion.
- When the job succeeds during the wait, the CLI prints the completed result (with `--json`,
  the result object, not just a receipt). If still pending, it can print the current status (`--json` prints the job object),
  or exit with a polling-stopped error and recovery guidance when its local deadline expires.
  Very short waits such as `--timeout 1` can expire during the fixed two-second polling interval;
  use `0` for admission-only output. Disconnecting does not cancel or resubmit the build.

Recover without starting another build:

```sh
armada golden build-status <job-id> --json
armada golden build-status --idempotency-key <saved-key> --org <org> --json
```

If admission's response is lost, recover by the saved key first. The same requester/org/key
and identical request identify the same job; changed input with that key conflicts. Never
switch to a fresh key to bypass an uncertain outcome or retained capacity. For
`recovery_required`, contact an operator to reconcile the original build before retrying.
See [Durable golden build jobs](golden-build-jobs.md) for exact client semantics, failure
reasons and worker/recovery details; old synchronous create/update contracts are not supported.

## API and MCP create/update

Both surfaces admit durable jobs, not inline snapshots. Control API requests use
`Authorization: Bearer <Armada bearer>` and `Content-Type: application/json`.

`POST /api/v1/golden/create` example (replace placeholders, retaining the saved key):

```json
{
  "name": "web",
  "repos": ["acme/web", "acme/infra"],
  "org": "<org-id>",
  "provider": "boat",
  "private": false,
  "setup": "bun install\n",
  "idempotencyKey": "<saved-key>"
}
```

| Surface | Current request fields |
| --- | --- |
| API create | Required `name`, `idempotencyKey`, and `repos` unless `config` is supplied. Optional `org`, `provider`, `private` (default false), `setup`. `config` is the golden config object, not a file path. |
| API update (`POST /api/v1/golden/update`) | Required `name`, `config`, `idempotencyKey`; optional `org`, `provider`, `setup`. Owner/visibility come from the existing golden. |
| MCP `golden_create` | Required `name`, `repos`, `idempotencyKey`; optional `org`, `provider`, `private`, `setup`. No `config` field. |
| MCP `golden_update` | Required `name`, `repos`, `idempotencyKey`; optional `org`, `provider`, `setup`. No `config` or `private` field. |

MCP `repos` contains 1–16 `owner/repo` entries. Private repositories require a
caller-visible GitHub App installation; caller-verified public repositories need not have one. `setup`
is script text, not the CLI's local file path. MCP `org` is an org ID (needed when membership
is ambiguous); API `org` accepts an ID or name. Use IDs for portable examples.

API create/update return HTTP **202** with a status receipt; MCP returns the same job shape.
A typical admission receipt is:

```json
{
  "jobId": "<job-uuid>",
  "provider": "boat",
  "state": "queued",
  "phase": "queued",
  "errorCode": null,
  "result": null
}
```

Poll `POST /api/v1/golden/build/status` with `{"jobId":"<job-uuid>"}`, or recover by
`{"org":"<org-id>","idempotencyKey":"<saved-key>"}`. MCP callers use
`golden_build_status` with those same fields. Reads authenticate and check current membership;
private jobs remain owner-only, even against admins. States are `queued`, `running`,
`succeeded`, `failed`, `recovery_required`. Only success supplies the terminal public result
(`name`, `visibility`, `snapshot`, optional `warnings`). Polling errors never justify resubmission.

## Connect and scanned maintenance snapshot

These are **not durable create/update jobs**. They perform the requested maintenance operation
and return its result; they do not accept a build idempotency key or return a job receipt.

```sh
armada golden connect web --provider boat --org <org> --json
# Maintain only non-secret repositories/dependencies/configuration in the canonical master.
armada golden snapshot web --provider boat --org <org> --json
```

`POST /api/v1/golden/connect` takes `name`, optional `org` and `provider`, and returns
`{golden, sandboxId, webUrl}` (`webUrl` is currently null). It opens/restores the canonical
master through Armada; it is not a direct-provider CLI connection or a credential bypass.
`POST /api/v1/golden/snapshot` takes the same fields, restores the master if necessary,
runs the fail-closed scan, then saves and returns `{name, snapshot}`. MCP `golden_snapshot`
accepts those same fields and returns that snapshot result; there is no `golden_connect` tool.
Both maintenance routes enforce current mutation rights and the stored backend binding.
A timeout is not proof that a snapshot was never saved: inspect the golden's current state
before deciding what to do, rather than treating it as a durable build job to poll or replay.

## Security model

- Repository access is checked with the caller's connected [GitHub identity](github-app.md),
  never the App's broader visibility. Private repositories require an installation the caller
  can access. Missing/revoked/unavailable GitHub access prevents a build.
- Checkout uses the caller's cached OAuth access token, or an optional short-lived,
  repository-scoped installation token when the server has signing credentials and the
  repositories share one installation. Public repositories without an installation and
  repositories spanning installations use the caller-token fallback. The minted token is
  revoked after checkout; the shared user token is not revoked by the build. Credentials travel
  over pinned SSH on stdin, not argv, git config or persistent credential files.
- Disposable builders receive no account environment secrets. A fail-closed scan covers the
  filesystem and git history/objects before snapshot publication; diagnostics disclose bounded location classes/counts,
  never matched values or file paths. A match, timeout or inability to run the scan blocks publication.
  This is a defensive check, **not proof that every possible secret has been removed**.
- Successful create/update publication follows scanning and a ready snapshot. Failed or
  ambiguous builds do not publish a new golden pointer; update retains the last-good snapshot.
  Uncertain artifacts/capacity may be retained for reconciliation, not blindly rebuilt or deleted.
  Details belong in [the build-job reference](golden-build-jobs.md).

## Server environment

These are server settings, not CLI credentials. Provider credentials and routing must also be
configured on the server; see [self-hosting](self-hosting.md).

| Variable | Required | Effect |
| --- | --- | --- |
| `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | yes for GitHub identity | Resolves the caller's cached access token; see [GitHub App setup](github-app.md). |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | no | Enables scoped installation tokens; otherwise checkout uses the caller's token. |

The server container needs `ssh` and `ssh-keygen` on `PATH` (`openssh-client`);
`Dockerfile` installs them. Durable build deployment prerequisites and operator-only recovery
remain in [golden-build-jobs.md](golden-build-jobs.md#deployment); this guide does not authorize
migrations, deployments or provider operations.
