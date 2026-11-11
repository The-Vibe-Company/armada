# Setup and configuration

## GitHub and model access

Use `armada github status` and, with the human present,
`armada github connect` or `armada github reconnect`. Installation access and
user authorization are distinct: ensure the App can access the requested repo.
`armada github refresh SANDBOX` refreshes sandbox GitHub access after connection
repair; it is not a model-account refresh or a way around repository permissions.

Inspect `armada creds list`. Model credentials resolve personal over org defaults;
select an account explicitly with `armada launch GOLDEN --agent codex --credential-id ACCOUNT`.
For native subscription login use `armada creds login codex --name ACCOUNT_NAME`;
Claude/native imports use `armada creds import claude --name ACCOUNT_NAME --file TOKEN_FILE`.
API credentials use `armada creds set openai --file KEY_FILE`.
Values arrive only via stdin or files, never argv. Files should be locally secured;
do not read them into agent output. Org credential mutation needs appropriate
admin rights. Skillpack is a credential kind:
`armada creds set skillpack --file KEY_FILE`. Use the credential with access to
the exact private skill versions you intend to pin.

## Goldens

Prefer an existing golden. To create one with authorized repos:

```sh
armada golden create NAME --repo https://github.com/example/project@main --provider boat --idempotency-key BUILD_KEY --timeout 60
```

Goldens must contain no secrets, including git history. Setup scripts are build
inputs, not secret injection. On disconnect preserve the admission key and inspect
`armada golden build-status --idempotency-key BUILD_KEY --org ORG`;
do not resubmit with a new key. Use `armada golden build-status JOB_ID` once
known. A failed secret scan needs source/history cleanup, never bypassing scans.
`armada golden update NAME --config CONFIG_FILE --provider boat` rebuilds an
existing golden; `armada golden connect NAME --provider boat` opens its canonical
master for maintenance and `armada golden snapshot NAME --provider boat` scans
and freezes it. These affect future work: obtain permission before changing a
shared environment.

## Templates, readable variables and secrets

Use `armada template create NAME --file definition.json` to create a definition;
`armada template publish TEMPLATE --expected-revision 1 --file definition.json`
publishes another immutable revision with optimistic concurrency protection.
Inspect current state before retrying a revision conflict.

Readable configuration is not secret: `armada vars set SETTING --file VALUE_FILE`
and `armada vars list --json` manage references; `armada vars read VARIABLE_ID`
prints the value. Do not run read on sensitive values or in shared logs.
Templates can reference readable variable IDs/versions and pin skills. Resolved
launch manifests freeze readable values and current connected grants at launch,
not when the revision is published. Boat delivers readable configuration to the
native harness through a world-readable file; unrelated exec does not inherit
its environment but can read the file. It is not a secret channel.

`armada secrets set SECRET_NAME --file SECRET_FILE` stores write-only application
secrets; `armada secrets list --json` returns metadata. There is no reveal command
or automatic sandbox delivery for this secret store. Do not confuse it with model
credentials, or promise template secret binding. Secret rotation in Armada does
not rotate the upstream service's key. Never bake any of these secrets into a
golden, skill, git repository or prompt.
