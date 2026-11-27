# Setup and configuration

## GitHub and model access

Use `armada account ls github` (add `--json` or pipe stdout for raw metadata) to
inspect connected GitHub organizations and repository scopes (`all` vs `selected`).
With the human present, use `armada account login github` to authorize or reauthorize,
and `armada account add github` (pass `--no-wait` when waiting for GitHub org admin
approval) to install the Armada GitHub App on another organization or update selected
repositories. Installation access and user authorization are distinct: ensure the App
can access the requested repo.
`armada api github/refresh '{"id":"SANDBOX"}'` refreshes sandbox GitHub access after connection
repair; it is not a model-account refresh or a way around repository permissions.

Inspect `armada account ls`. Model credentials resolve personal over org defaults;
select an account explicitly with `armada new GOLDEN --provider boat --agent codex --credential-id ACCOUNT`.
For native subscription login use `armada account login codex --name ACCOUNT_NAME`;
for Google sign-in use `armada account login antigravity --name ACCOUNT_NAME` with the human present.
Claude/native imports use `armada account import claude --name ACCOUNT_NAME --file TOKEN_FILE`.
API credentials use `armada account add openai --file KEY_FILE`.
Values arrive only via stdin or files, never argv. Files should be locally secured;
do not read them into agent output. Org credential mutation needs appropriate
admin rights. Skillpack is a credential kind:
`armada account add skillpack --file KEY_FILE`. Use the credential with access to
the exact private skill versions you intend to pin.

## Goldens

Prefer an existing golden. To create one with authorized repos:

```sh
armada snapshot new NAME --repo https://github.com/example/project@main --provider boat --idempotency-key BUILD_KEY --wait --timeout 60
```

Goldens must contain no secrets, including git history. Setup scripts are build
inputs, not secret injection. On disconnect preserve the admission key and inspect
`armada snapshot show --idempotency-key BUILD_KEY --org ORG_UUID`;
do not resubmit with a new key. Use `armada snapshot show --build JOB_ID` once
known. A failed secret scan needs source/history cleanup, never bypassing scans.
`armada snapshot update NAME --replace --config CONFIG_FILE --provider boat` rebuilds an
existing golden from its build configuration. Obtain permission before changing a
shared environment.

## Templates, readable variables and secrets

Create, publish and delete template definitions in the dashboard or use
`armada api templates/create -`, `armada api templates/publish -` and
`armada api templates/delete -` with JSON on stdin. Send the organization UUID in
`org` on each request. Create takes `name`, `scope` (`personal` or `org`) and
`definition`. Publish takes the template UUID in `id`, the current
`expectedRevision` and a complete `definition`. Delete takes `id` and
`expectedRevision`. Inspect current state before retrying a revision conflict.

Manage application variables and write-only secrets in the dashboard or send
JSON on stdin to `armada api variables/set -` and `armada api secrets/set -`.
Both routes take `org` (the organization UUID), `scope` (`personal` or `org`),
`name`, and `value`. Use `armada api variables/list -` or
`armada api secrets/list -` with `org` to get IDs and versions. Reading a
variable with `armada api variables/read -` (body fields `org` and `id`) prints
its value. Keep that output out of shared logs. Templates can reference readable
variables by ID and version and pin skills. Launch freezes readable values and
current connected grants in its manifest. On the native Boat path, readable
configuration is delivered through a world-readable file. Use that channel
only for values safe to expose inside the sandbox.

To rotate, revoke, or delete a secret, use `armada api secrets/rotate -`,
`armada api secrets/revoke -`, or `armada api secrets/delete -`. Send `org`, `id`,
and the current `expectedVersion`. Rotation also takes the replacement `value`.
Inspect metadata before retrying a version conflict. Secret responses contain
metadata only. Rotation in Armada changes the stored value and leaves the
upstream service's key as it was. Keep secret values out of command arguments,
logs, goldens, skills, git repositories, and prompts.
