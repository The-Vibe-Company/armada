# Templates from the CLI

Use `armada template` for API-only template management. `template launch` keeps
revision selection and durable request keys together without changing ordinary
golden launches. Templates contain readable configuration and value-free secret ID/version bindings.

Create a personal preset in your selected organization from a definition file
(the definition shape is documented in [templates-staging.md](templates-staging.md)):

```sh
armada template create my-preset --file definition.json
armada template list
armada template get my-preset
```

When supplying `--org UUID` on create, explicitly choose `--scope personal|org`.
Organization templates require an administrator to create, publish or delete.

Publish a complete replacement definition as a new immutable revision, or delete
using the current revision as an optimistic-concurrency guard:

```sh
armada template publish TEMPLATE_ID --expected-revision 1 --file definition.json
armada template delete TEMPLATE_ID --expected-revision 2
```

Launch with `armada template launch NAME_OR_ID --request-key unique-run-1`.
For a name-based launch, the CLI prints its resolved template ID before submission.
Retain that ID and key. To recover a lost response, retry with that ID and the same
organization, revision and overrides (the same API body), without allocating again.
Use the ID rather than the name even if the template was later renamed or deleted. Do not invent a new key while an earlier outcome is unknown.
Only prompt, TTL, size and repository may override the preset; tools, model and
readable-variable versions require publication. Use `--json` to inspect the
returned frozen manifest; readable values may appear there.

## Coordinator staging acceptance

Against a disposable staging deployment only: create a template on a staging
golden from this CLI, launch it using a stable request key, then confirm the
intended tools/workspaces, model/effort and readable variables in the native
agent. Exercise matching and stale revision publication. No production deployment
or migration is part of this CLI change.

Secret references: repeat `--secret KEY:UUID:VERSION` in create/publish, or use the definition file’s `secrets` array. Never pass a secret value to template commands.
