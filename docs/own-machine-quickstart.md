# Run agents on your own Linux machine

**Self-hosted compute** means your Linux machine runs the agents' Docker containers;
you still sign in to an Armada server and use its dashboard/API. You do **not**
need to deploy Armada, Supabase or a database. Boat/Modal accounts are not required
for this path.

## Before registering

- Use Linux x64 or arm64, with an architecture supported by your Armada server's
  runtime configuration. Ask the server operator if unsure.
- Install Docker and its CLI; verify `docker info` works as the Linux user who
  will install the host. Snapshot builds also need Docker Buildx with the
  docker-container driver.
- Have curl, sha256sum, util-linux flock/loginctl, and a working systemd user
  session. The installer enables linger so the user service survives logout.
  An administrator may need to configure linger and Docker access first.
- Allow outbound HTTPS to your Armada server, artifact/image registries, GitHub
  and your model provider. No inbound host port is needed.
- Use a machine you trust with your code and agents. Docker is **not** a hostile
  multi-tenant security boundary: Docker socket access is powerful, commonly
  equivalent to root with rootful Docker. Prefer rootless Docker where available.
  The installer does not run sudo. Do not give untrusted users Docker access;
  host administrators can inspect workloads and their delivered credentials.

### Does my Armada server support it?

In the dashboard's selected organization, look for **Setup → Machines → Your own servers**.
An org admin registers hosts. Hosts and new Docker placements are separate server
opt-ins: a visible host list does not guarantee new launches are enabled.
`armada host list --org ORG_UUID --json` reports `placement` and host states.

If Self-hosted or Docker launch is absent/disabled, confirm your org and admin
role, then ask the Armada server operator whether host registration and Docker
placement are enabled and whether your architecture is supported. Do not assume
the public deployment enables them. Choose Boat/Modal in the meantime.
Operators, not users, own the [deployment prerequisites](docker-host-daemon.md#staging-prerequisites-coordinator-only);
this guide does not enable any feature.

## 1. Sign in and prepare your account

[Install the CLI and sign in](dave-onboarding.md#1-install-the-cli), then
[create/select an organization](dave-onboarding.md#4-create-or-select-an-org).
You must be an org admin to add a host. Run `armada org current` and copy its
UUID; replace ORG_UUID below consistently.

Store your model credentials and connect GitHub before launching. For API keys
or a new subscription login, follow [model-account setup](dave-onboarding.md#store-a-model-credential).
The Codex file import below assumes you have already signed in with the native
Codex CLI and have an eligible account:

```sh
armada creds set codex-auth --file ~/.codex/auth.json
# Or Claude Code:
# printenv CLAUDE_CODE_OAUTH_TOKEN | armada creds set claude-oauth
armada creds list
armada github connect
```

Use your own connected GitHub account with access to the repositories in the
examples. The examples use Codex; choose a usable personal default model account
or explicitly pass `--credential-id ACCOUNT_UUID` when launching. Never put a
credential value in an argument.

Morph is also supported: one account can serve Claude Code, Codex and OpenCode.
Use a compatible Morph model and explicitly select that account if it is not
your default; see [Morph setup](morph.md). Model-account capacity applies to
Docker just as to cloud launches: Morph defaults to 2 simultaneous agents per
account, other kinds to unlimited. Stopped/idle-paused sandboxes do not count.
A busy account refuses admission without silently choosing another one.
Set `--max-agents N` or `--unlimited` when storing an account, or update it:

```sh
armada creds limits ACCOUNT_UUID --max-agents 2
armada creds limits ACCOUNT_UUID --unlimited
```

These are model-account limits, distinct from the host's CPU/memory and
simultaneous-sandbox capacity.

## 2. Register the Linux machine

In **Setup → Machines → Your own servers**, choose **Add your own server**, or run:

```sh
armada host add --name office --org ORG_UUID
```

Copy the generated one-line command and run it **on the Linux Docker machine**,
as the user with Docker access. It downloads and verifies the managed host binary,
registers it and installs a user service. The one-time registration command
contains a sensitive, single-use token that expires in five minutes: do not
share it, log it or commit it. Never substitute an example token.

Wait for `connected` and for the exact host to appear **online** in the
dashboard or CLI:

```sh
armada host list --org ORG_UUID
armada host show office --org ORG_UUID
```

On the Linux machine, check the local installation with:

```sh
~/.local/bin/armada-docker-host status
```

Online means the daemon has polled, not that an agent is ready. If installation
reports pending or an uncertain result, inspect status before trying again;
do not blindly replay the registration command. Local service management belongs
to `armada-docker-host`, not `armada host`: the latter manages server registrations.
To remove the managed installation later, use
`~/.local/bin/armada-docker-host uninstall`; it drains/revokes before removal
and refuses uncertain cleanup. See [managed installation troubleshooting](docker-host-daemon.md#managed-owner-installation-1453).

## 3. First launch: fresh workspace

Replace `your-org/your-repo` with an accessible repository. No snapshot is needed:

```sh
armada launch "Summarize this repository; do not change files" \
  --provider docker --host office --org ORG_UUID --agent codex \
  --repo your-org/your-repo@main
armada status SANDBOX_ID
armada logs SANDBOX_ID --follow
armada stop SANDBOX_ID
```

Use the returned sandbox ID, not the host ID. The server chooses the official
Armada environment; no image flag is required. Preparation may still be running
when launch returns: follow status/logs until the agent answers. An ambiguous
host name requires the UUID from `host list`. See [driving a sandbox](dave-onboarding.md#6-launch-from-the-cli)
for follow-up commands.

## 4. Optional: a reusable two-repository snapshot

Choose this instead of a fresh checkout when you want repositories and setup
baked once. Create `workspace.json` locally, using your repositories and setup
commands (never credentials):

```json
{
  "repos": [
    { "url": "https://github.com/your-org/web.git", "branch": "main", "dir": "web" },
    { "url": "https://github.com/your-org/api.git", "branch": "main", "dir": "api" }
  ],
  "init": [
    "cd /home/user/web && bun install",
    "cd /home/user/api && bun install"
  ]
}
```

```sh
armada snapshot create workspace --provider docker --host office --org ORG_UUID \
  --config workspace.json --private
armada snapshot list --provider docker --org ORG_UUID
armada snapshot get SNAPSHOT_UUID --provider docker --org ORG_UUID
# Wait for ready, then use the returned snapshot UUID:
armada launch "Summarize both repositories" --provider docker \
  --golden SNAPSHOT_UUID --org ORG_UUID --agent codex
```

In the dashboard: **Launch from → Snapshots → New**, choose **your server <name>** in the build placement selector,
choose **Use a snapshot file instead** to upload the same JSON, then launch the ready snapshot. Private is the default;
only admins can publish organization snapshots.

A snapshot is host-local: it launches on its original host, not Boat/Modal or
another Docker machine. Launch selects the snapshot instead of `--host`,
`--image` or `--repo`. It uses the baked workspace without re-running checkout
or init; build a new snapshot when you need newer contents. Builds require
GitHub access and a secret scan, but not a model account; launching needs one.
For build failures, retries and updates, see [host-local snapshots](docker-snapshots.md).
