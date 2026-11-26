# Armada

<p align="center">
  <a href="https://armada.thevibecompany.co"><b>Open Armada in your browser</b></a>
  &nbsp;·&nbsp;
  <a href="#install"><b>Install the CLI</b></a>
  &nbsp;·&nbsp;
  <a href="#quickstart">Quickstart</a>
  &nbsp;·&nbsp;
  <a href="#documentation">Docs</a>
  &nbsp;·&nbsp;
  <a href="docs/api/README.md"><b>Embed Armada</b></a>
</p>

**Have your own Linux machine?** [Run agents on your Docker host](docs/own-machine-quickstart.md) without hosting the Armada server (requires server opt-in).

**Armada gives every coding task its own machine.** Save your repositories and setup once as a *snapshot*. Launch Claude Code, Codex or OpenCode into a fresh sandbox with the model and reasoning effort you choose. Follow every event, redirect the agent mid-turn, stop the machine and pick the same conversation back up later, from the web, the terminal or any MCP client.

```sh
npm install -g @the-vibe-company/armada
armada login
```

Open source, MIT. Sandboxes run on a connected Boat or Modal account or on a registered Docker host. Agents use your model accounts. OpenCode on Boat requires the Armada runtime.

## Why Armada

- **Start from a ready workspace.** A snapshot saves your repositories, branches and setup after a secret scan; every launch forks it and pulls the latest commits.
- **Choose the agent and model.** Claude Code, Codex or OpenCode, with the exact model and reasoning effort you name. Armada never swaps in another model.
- **One task, one sandbox.** Each launch gets its own sandbox, only that agent's credentials, and your GitHub identity once you connect it.
- **See and steer every move.** Follow events live, send the next prompt, steer or interrupt the running turn, run a command beside it.
- **Stop and pick up later.** Stopping normally preserves the disk and conversation for the next prompt. If a Modal checkpoint fails, the current disk is not retained and resume is refused; [push work before stopping](docs/modal-stop-recovery.md).
- **Bring your tools and your team.** Attach the MCP servers you connected, share snapshots with your org or keep them private, and give bots a service token.

## How it works

For your own compute, [register a Docker host and choose fresh launch or a host-local snapshot](docs/own-machine-quickstart.md) instead of the cloud path below.

1. **Snapshot**: build once from your repositories (`armada snapshot new`).
2. **Launch**: pick an agent, the model, the effort and the provider (`armada new`).
3. **Sandbox**: a fresh, isolated fork where `git` and `gh` act as you.
4. **Drive**: follow, steer, stop and resume (`armada events -f`, `armada prompt`).

The dashboard, the `armada` CLI and Armada's MCP server all call the same Armada server, so a sandbox launched from one is visible and controllable from the others, under the same permissions.

## Install

```sh
npm install --global @the-vibe-company/armada
armada --version
```

Or run it once without installing: `npx @the-vibe-company/armada --help` (or `bun x --bun @the-vibe-company/armada --help`).

The package ships a prebuilt binary for Linux and macOS, x64 and arm64, so it needs Node 18 or later and nothing else. Do not install with `--omit=optional`: the binary is the optional dependency that matches your machine.

The CLI only talks to the Armada API. It keeps your Armada session (or reads `ARMADA_TOKEN`) and never holds provider, database or Supabase credentials.

## Quickstart

For self-hosted compute instead of Boat/Modal, follow the [own-machine quickstart](docs/own-machine-quickstart.md): register your Linux Docker host, launch fresh, or build a host-local snapshot.

Installing is the first step; an agent also needs a sandbox provider, model credentials, GitHub access and a ready snapshot. Each step below also has a page in the [dashboard](https://armada.thevibecompany.co), which walks a new organization through the same setup.

The dashboard sidebar has **Running**, **Launch from**, **What agents have** and
**Setup**. Start with **Setup → Machines**, then **Models** and **Your connections**;
build a workspace at **Launch from → Snapshots → New**. **Sandboxes → Launch a sandbox** opens the launch dialog. [Dashboard navigation and terminology](docs/dave-onboarding.md#find-your-way-around-the-dashboard)
covers Tools, template versions and routines. CLI command names below are unchanged.

**1. Sign in.** Open the dashboard link printed by the CLI, sign in with an enabled dashboard method, and authorize the terminal. Use `--url <armada-url>` (or `ARMADA_URL`) for another deployment.

```sh
armada login
```

**2. Choose an organization and connect a sandbox provider.** Create one in the dashboard (you become its admin) or ask an admin to invite you, then select it with `armada org use <name>` (no second browser login needed). An admin connects Boat or Modal once for the whole organization; the key is read from stdin or `--file`, never from an argument.

```sh
armada org use acme
printenv BOAT_API_KEY | armada org connect boat --org acme
# Modal instead: printf '%s %s' "$MODAL_TOKEN_ID" "$MODAL_TOKEN_SECRET" | armada org connect modal --org acme
armada org setup --org acme
```

**3. Store your model credentials.** Your own credentials win over the organization's. Values are encrypted and never shown again.

```sh
printenv CLAUDE_CODE_OAUTH_TOKEN | armada account add claude-oauth   # Claude Code (from `claude setup-token`); or kind `anthropic`
armada account add codex-auth --file ~/.codex/auth.json              # Codex; or kind `openai`
armada account ls
```

Morph is another model-account option for Claude Code, Codex and OpenCode:
add it in Models in the dashboard or use the [account API](docs/cli-admin.md#model-account-presets).
Select its account ID with `--credential-id ACCOUNT_UUID` and a Morph model such as
`--model morph-kimik31`; use Modal, Docker or runtime-backed Boat, not native Boat.
See [Morph accounts](docs/morph.md) for supported models and restrictions.

Model accounts have a per-account simultaneous-agent limit across sandbox providers.
Morph defaults to **2**; other accounts default to unlimited. Set `--max-agents N`
or `--unlimited` when adding an account, or change it with
`armada account limits ACCOUNT_UUID --max-agents 2`. Starts beyond the cap are refused
before allocating a machine; lowering it does not stop existing agents.
Follow-up sends to existing sandboxes can return a durable queued prompt receipt
when the account is full; they dispatch FIFO per account after capacity frees.
Queued is not running or completed: use `armada info --wait` or `armada events` for that sandbox and correlate the returned prompt ID.

**4. Connect GitHub.** Snapshots are cloned over your own GitHub connection, and sandboxes use it so commits and pull requests come from you.

```sh
armada account login github
```

**5. Build a snapshot.** The server clones the repositories in a disposable sandbox, runs your optional `--setup` script, scans for leaked secrets and only then saves the snapshot. `--init` commands run at every launch, after the pull. Add `--provider modal` to build it for Modal. Only admins build organization snapshots; members add `--private` to build one for themselves.

```sh
armada snapshot new web --repo https://github.com/acme/web@main --init "bun install" --org acme --wait
armada snapshot ls
```

A long build keeps running on the server. Check it with `armada snapshot show --build <job-id>` and wait for `succeeded` before launching.

**6. Launch an agent.** With a prompt the agent starts at once; without one the sandbox waits, ready, for your first prompt. In a snapshot with several repositories, `--repo owner/repo` starts the agent in that one ([details](docs/dave-onboarding.md#6-launch-from-the-cli)).

```sh
armada new web --provider boat --agent claude --model claude-opus-5-5 --reasoning-effort high --ttl 4h \
  "Find why the checkout test is flaky and fix it"
```

**7. Drive it.** Replace `SANDBOX_ID` with the ID printed by launch. Run `steer` while the turn is active, from another terminal if `events -f` is still running. Send a follow-up after the turn settles. The effort override below applies to a new turn on native Boat. On runtime-backed Boat, keep the launch effort by omitting the override.

```sh
armada events SANDBOX_ID -f
armada prompt --steer SANDBOX_ID "Keep the public API unchanged"
armada prompt SANDBOX_ID "Now add a regression test" --reasoning-effort xhigh   # this turn only
armada api sandbox/extend '{"id":"SANDBOX_ID","ttlSeconds":16200}'   # extend the 4h launch to 4h30m from now
armada stop SANDBOX_ID --after             # wait for settlement and stop if still idle; normally retains disk/conversation; Modal checkpoint failure does not
armada prompt SANDBOX_ID "Push the branch"   # resumes only if the stopped sandbox was retained
```

Extend an accessible running or idle sandbox as its owner or an org admin. The new deadline must be later than the current one and within server/provider limits. Boat resets its hard timer; Modal extensions must fit before the existing physical deadline minus a five-minute stop margin, without replacing the machine. Modal launch headroom is server-configured; see [sandbox lifetime limits](docs/sandbox-expiry-investigation.md#initial-delivery-scope).

`armada --help` lists every command. Without flags, Claude Code runs `claude-opus-5-5` and Codex `gpt-6.2-sol`, both at `medium` effort.

### Claude Fable 5.2

Fable (`claude-fable-5-2`) is not suggested in the shared catalogue: Boat is known not to honour that selection and rejects it with a readable `model_selection_mismatch` explanation. Modal forwards custom model IDs to Claude Code, but Fable execution has not been re-verified with an entitled account. Defaults remain unchanged; no substitution is permitted. See [provider evidence and production checks](docs/fable-provider-check.md).

## Bring your MCP servers

Register and authorize the connection in the dashboard. Use its connection ID
at launch. A personal connection requires a private snapshot for this cloud launch.

```sh
armada new private-web --provider boat --agent codex --connections CONNECTION_ID "Update the API reference"
armada api mcp/sandbox-connections '{"id":"SANDBOX_ID","org":"ORG_UUID"}'
```

See the [MCP administration routes](docs/cli-admin.md#mcp-connections).

## Drive Armada from your own agent

Armada is also a remote MCP server. Add it to Claude Code, Codex, Cursor or your own coordinator, and that agent can launch and drive sandboxes with `launch`, `list`, `status`, `logs`, `send`, `report`, `exec` and `stop`. Use `status` with `wait: true` to wait for settlement, `send` with `steer: true` to redirect a turn, and `stop` with `turn: true` to interrupt the turn while keeping the machine up.

MCP clients sign in with OAuth; bots and CI use a service token bound to one organization:

```sh
armada api token/create '{"org":"acme","label":"ci"}'
```

The response contains the key once. Capture it in a secret store. Your coordinator decides what to work on and when to merge; Armada gives each task a sandbox, an agent and a live event stream to drive. Endpoints and client configuration: [Connect an MCP client](docs/dave-onboarding.md#7-connect-an-mcp-client).

## Teams

| | Admin | Member |
| --- | :---: | :---: |
| Launch agents, and watch and stop your own | ✓ | ✓ |
| Watch and stop any sandbox in the organization | ✓ | |
| Create private snapshots and private sandboxes | ✓ | ✓ |
| Change organization snapshots, members and provider keys | ✓ | |

Snapshots and sandboxes follow two separate rules. A private snapshot is visible only to its owner, not even to admins. A sandbox's interior (transcript, logs and outputs) is readable by its owner and by organization admins, whether the sandbox is private or not, and admins can also stop it. Sending prompts is reserved to the owner: an admin's send to a colleague's sandbox is always refused, usually with `404 not_found`, or with `409 credential_binding_required` or `409 sandbox_terminal` when an earlier send check fails first (see [Embed Armada](docs/api/README.md#drive-the-sandbox-from-your-backend)). Ordinary members see only the metadata of sandboxes they do not own, such as status, agent and owner, in the organization's list. Admins can add an existing account immediately with the `members/add` API route (no invitation email), or create a pending invitation, including before the recipient has an account. An invitation grants membership only after explicit acceptance by a personal login with the matching verified email; opening its link does not join. See [invitations and acceptance](docs/cli-invitations.md#accept-an-invitation).

## Documentation

See [Embed Armada](docs/api/README.md) for the HTTP API and the [glossary](docs/glossary.md) for shared terminology. Start with the [Use / Develop / Operate reader map](docs/README.md) for canonical guides, contracts and operational runbooks. The [v2 specification](https://github.com/The-Vibe-Company/armada/issues/455) records the original design, not a promise that every proposal is shipped.

### Reading events and outputs

`armada events [ID]` reads one page. Use `--tail N` for recent events or
`-f` to follow until the sandbox settles. Piping stdout or passing `--json`
produces one JSON object per event.

```sh
armada events SANDBOX_ID -f | jq -c 'select(.kind == "message")'
armada outputs --id SANDBOX_ID
armada outputs report.json --id SANDBOX_ID -o ./downloads
```

Command discovery works before signing in: use `armada COMMAND --help` (or
`-h`) for sandbox, snapshot, authentication, organization, credential and MCP
commands. These work without reading a session or contacting a server.
Help is only intercepted when it is the sole argument after
the command; for example, `armada exec ID -- --help` remains remote command text.

### Sandbox errors and scripts

Sandbox commands select an explicit ID first, then `ARMADA_SANDBOX`, then the
ID in `.armada/sandbox` in the current directory. Successful launches record
their sandbox ID in that file. A UUID prefix must match exactly one visible
sandbox in the selected organization scope. For commands that take text, use
`--` to mark where the payload starts when you omit the ID, as in
`armada prompt -- Review the diff`.

Sandbox commands default to JSON when stdout is redirected or piped. On a
terminal, pass `--json` for machine output. A failed command in machine mode
ends stderr with one JSON line, for example
`{"error":{"code":"not_found","message":"Sandbox not found or not accessible.","hint":null}}`.
Read the final line because stderr can also carry progress or recovery details.
The exit code remains the script's success signal. Exit 2 means a usage/invalid-request
failure. Exit 3 means authentication is required: an authenticated command exits 3 with
`unauthorized` when there is no valid session or service token (or the API
answers HTTP 401) and no interactive sign-in took place. For example, signed-out
`armada ls` and `armada ls --json` exit 3 (bare `armada` prints help and exits 0).
Exit 1 means access denial, state, unsupported operation or service failure.
Check `armada ls --json` for visible IDs and state; verify your org selection
with `armada info --setup` or pass `--org UUID`.

Sandbox mutations are not replayed after transport/server failures or state
conflicts. Existing authentication recovery may refresh a personal session and
retry once after HTTP401. On a transport/server failure,
check its outcome before retrying: a prompt or stop may already have been
accepted. If status/detail cannot be read during a transition, inspect
`armada ls --json` instead; this guidance does not repair a stuck provider
lifecycle.

Scripts sending a bearer directly to `/mcp` do not use the CLI session store or its refresh/retry path. They must manage their own credential lifecycle: refresh OAuth credentials or renew expiring credentials, and replace revoked service tokens.

### Variables and secrets

Manage application variables and secrets in the dashboard or use the
[vault API commands](docs/cli-admin.md#application-variables-and-secrets)
for scripts.

## Contributing

See the [Contribution quickstart](docs/self-hosting.md#contribute-quickstart) for local setup, credential-free dashboard development, and validation.

## Armada v1

This repository used to hold Armada v1, a fleet coordinator (Linear, merge queue, desktop app; npm versions up to 0.2.73). Its last commit is tagged [`armada-v1-final`](https://github.com/The-Vibe-Company/armada/tree/armada-v1-final), and its history and release tags stay here. v2 replaces it under the same `@the-vibe-company/armada` package: installing the latest version upgrades the global CLI.

## License

[MIT](LICENSE)
