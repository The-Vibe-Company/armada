# Templates from the CLI

Use `armada template` for API-only template management. `template launch` keeps
revision selection and durable request keys together without changing ordinary
snapshot launches. Templates contain readable configuration and value-free secret ID/version bindings.

In the dashboard, find templates under **Launch from → Templates**. The screen calls
immutable revisions **versions**; the CLI retains `publish`, `--revision` and
`--expected-revision`. **Launch** opens **Launch <template name>** with that version’s choices fixed.
**Running → Routines → New routine** schedules a task against the template as it is
at creation, not against future versions.

Create a personal preset in your selected organization from a definition file
using the definition below:

```sh
armada template create my-preset --file definition.json
armada template list
armada template get my-preset
```

Docker placement uses the same definition file and template/routine launch path:

```json
{
  "provider": "docker",
  "hostId": "HOST_UUID",
  "harness": "codex",
  "connections": [],
  "skills": []
}
```

To use a built Docker environment, add `"snapshotId": "SNAPSHOT_UUID"` to the
definition above. Publish it using `--file`; snapshot selection is not a launch
override. Omit `snapshotId` to keep the existing official host environment.
`goldenId` and `goldenBinding` remain null: Docker snapshots are built per host,
not reused from Modal or Boat snapshots.

The host must be registered, active and in the selected organization, with its
issuer still a member. A selected snapshot must be ready, visible to the caller
and bound to that host's current installation. Org templates require org-visible
snapshots; personal templates can use the owner's private snapshot or an org one.
Admission freezes the snapshot ID in the revision alongside the host installation/
issuer, model account, connection grants and resolved skills. Source access is
checked again before reservation and start. The normal Docker launch path uses
the snapshot's image and repository config; callers cannot choose another image
or rerun snapshot init. Existing admitted request keys replay their stored receipt
even when a source later becomes unavailable; new keys must pass current checks.

Docker children are private to the launcher. Definitions support readable-variable
and secret references; repository and size launch overrides remain unsupported.
The dashboard also creates, changes, removes and launches Docker templates. In
**Launch from → Templates → New template**, the **Snapshot** selector lists ready
host-local snapshots under **Your server <name>** alongside cloud snapshots. Save
with **Save template**. In an editable template’s details, **Change** opens the
form; **Save as version N** creates a new version rather than replacing history.
**Remove → Remove template** confirms deletion. These controls have the same
visibility and authorization limits as the CLI. Routines use their persisted owner's authority and
the same pinned template path, so they inherit its snapshot choice, with original-
prompt observation through Docker status. Real-host execution is coordinator-owned.

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
Only prompt, TTL, size, repository and an unpinned model account may override
the preset; tools, model and readable-variable versions require publication.
Select an unpinned account with both `--model-account ACCOUNT_UUID` and
`--model-account-version N`; a pinned account cannot be replaced at launch. Use `--json` to inspect the
returned frozen manifest; readable values may appear there.

## Definition and API

```json
{
  "goldenId": "<provider-specific-snapshot-uuid>",
  "provider": "modal",
  "harness": "codex",
  "model": "<supported-model-id>",
  "reasoningEffort": "medium",
  "modelAccount": {"id": "<account-uuid>", "version": 1},
  "connections": ["<connected-mcp-uuid>"],
  "variables": [{"key": "APP_REGION", "variableId": "<variable-uuid>", "version": 1}],
  "secrets": [{"key": "APP_TOKEN", "secretId": "<secret-uuid>", "version": 1}],
  "skills": ["<org/skill@exact-version>"]
}
```

Omit unused selections. Omitted model/effort freeze current harness defaults;
omitted account resolves the launching actor's user-over-org default, then freezes
its ID/version. Pinned accounts never silently fall back. Revisions store connection
IDs, not access tokens: current connected grant generations/versions resolve at
launch admission, so ordinary OAuth refresh requires no republication. Variables
and secrets require explicit versions. The JSON field `goldenId` and definition
flag `--golden UUID` retain their API/CLI spelling but identify a Boat or Modal
snapshot; do not rename the field to `snapshotId` (that field selects a Docker
snapshot).

Morph is a model account, not a sandbox provider. Its shared account supports
Claude Code, Codex and OpenCode; use a supported Morph model and a
runtime-backed launch (native Boat is unsupported). See [Morph](morph.md).
Per-account simultaneous-agent limits also apply to template/routine launches:
Morph defaults to 2, other accounts to unlimited. A busy account refuses admission,
not a silent fallback; wait for capacity or deliberately select another eligible
unpinned account. Follow-up sends to existing sandboxes can instead queue durably
for account capacity, dispatching FIFO per account. A queued receipt is not evidence
that the prompt ran; read its outcome with wait/logs. See the [account setup and limits](dave-onboarding.md). No arbitrary environment override exists.

Authenticated no-store POST `/api/v1/templates/{create,list,get,publish,delete,launch}`
and MCP `template_{create,list,get,publish,delete,launch}` share validation; the
public dashboard proxy supports all six. Every body needs `org` UUID. Unknown
fields/query parameters refuse at direct control; the proxy strips query strings.

| Operation | Additional fields |
| --- | --- |
| create | `name`, `scope` (`personal`/`org`), `definition` |
| list | none |
| get | `id`, optional `revision` (default current) |
| publish | `id`, `expectedRevision`, complete `definition` |
| delete | `id`, `expectedRevision` |
| launch | `id`, optional `revision`, required `requestKey`, optional `prompt`, `ttlSeconds`, `size`, `repo` |

`requestKey` is 1–128 ASCII characters from letters, digits, `.`, `_`, `:`, `-`.
Stale publication/deletion conflicts; publication is a new immutable revision,
not an edit. Deletion tombstones the header and retains revisions/requests.
Personal resources are owner-only with current membership; org members may use
shared templates, but only admins mutate them. Org templates cannot bind personal
resources; there is no in-place scope promotion. An environment publisher/admin
can inspect values delivered into its machine even from personal configuration.

## Frozen admission, pins and recovery

The first durable claim freezes revision/hash, eligible saved snapshot/config/
provider (including Modal binding), current tool generations, account ID/version,
variable versions/copied readable values, secret references, exact skills and
actor epoch. Its golden-operation fence pins that snapshot while allocation
awaits: an in-flight launch stays on A or refuses if A is retired; a new key may
follow rebuilt B without republication. A completed result replays unchanged,
including its original manifest and receipts; readable values intentionally appear
there, **never secret values**. Prompts are not generic request metadata.

Up to 20 distinct exact public `org/slug@version` or private `slug@version` pins
are accepted; duplicate slugs/floating versions refuse. Private pins resolve the
launching actor's Skillpack key, not the author's. Publication is not registry
access proof. Requested pins stay in `manifest.definition.skills`; successful
result `manifest.skillReceipts` and sandbox receipts record version, ID, SHA256
and registry origin. Older results can omit that additive evidence. Replay does
not reinstall. Failed/ambiguous results never claim installation success.

Concurrent/lost-response retries use the **same ID, key and input**; changed input
conflicts. Unknown allocation remains `reconciling`, not success or absence.
There is no automatic ambiguous-request retry worker. A crash during claim/
allocation retains the record and fence for inspection of logical/provider IDs
and ownership labels. Never delete request rows or invent a fresh key to recover
an unknown outcome. Keys/manifests do not expire into new work.

Refusals retain actionable direct-launch codes/messages and replay unchanged.
The dashboard can offer another eligible account only for an unpinned template;
a definite refusal can use a new request, an uncertain allocation cannot. Busy
holder links must be visible only while the caller has access to that sandbox.

## Readable configuration

Values resolve after pull/init, skills and MCP preparation at final-start admission,
not snapshot build. Maximum 64 combined bindings, 8 KiB UTF-8/value and 64 KiB total;
empty/multiline/literal shell text is supported. Reserved infrastructure names,
duplicate keys, NUL and invalid Unicode refuse without echoing values.

Modal uses authenticated private `configureReadableVariables`, only for the selected
native driver's future environment, not ordinary exec or replay journals. Identical
live configuration ACKs; conflicting same-incarnation configuration refuses.
Boat uses pinned SSH-stdin bootstrap and a root-owned **0644 world-readable** JSON
file under `/run/armada-readable-variables/<harness>.json`; the selected native
wrapper reads it. Unrelated exec does not inherit its environment **but can read
that file**. This is configuration, not confidentiality. A digest probe avoids
reinstallation while unchanged; a new VM or cleared `/run` requires re-delivery.

Later readable delivery checks current membership/interior access but uses the
frozen manifest, not mutable template/variable/account/tool reference versions.
Editing/deleting the source template or variable does not recall copied values;
normal independent model/tool/sandbox authorization still applies. New Modal
incarnations and Boat resume rehydrate that manifest. Non-template prompts add
no template lookup round trips or SSH; only nonempty readable manifests prepare.

## Secret bindings and security limits

With definition flags, repeat CLI `--secret KEY:UUID:VERSION` on create/publish.
With `--file`, put reference-only bindings in `definition.secrets` instead;
`--file` cannot be combined with definition flags (including `--secret`).
Alternatively, select names/scope in the dashboard Secrets picker.
Never pass secret values to template commands. Publication/admission check current
membership, ownership/org scope, active status, expiry and exact version; the whole
decrypted environment is size-validated before allocation. References only enter
manifests/receipts/API responses. At final start values decrypt in memory and use
the existing selected native-harness environment transport. Later turns re-resolve
the same references under current access/version checks. Rotate, publish a new
revision and launch anew; old-version delivery refuses. Revoke/expiry refuses
subsequent delivery but cannot erase already-delivered copies.

The owner-approved raw-delivery path is enabled on Boat and Modal, including
Boat's readable `/run` file. **It adds no taint marker or secret-safe recovery,
retention, snapshot, redaction or erasure guarantee**; ordinary sandbox lifecycle
still applies. Agents/children, same-UID/root users, provider-key holders and
environment publishers may read/exfiltrate plaintext. Encodings, screenshots,
files, commits and network output can evade known-value masking. Deleting a
vault entry does not erase provider/backups/delivered copies; rotate upstream
credentials after exposure. Model credentials are separately managed.

Existing irreversible `application_secret_tainted` rows retain their stricter
recovery/preservation/resume/ordinary-exec refusal. That legacy gate is **not** a
concurrency-safe admission protocol or proof of provider-internal recovery fencing.
Do not manually mark real workloads or infer that current template delivery uses
that gate. The broader hardening [design](design/templates-variables-secrets.md)
remains proposed; no proposed 30-day redaction store, owner-only interior rule,
child-text guard or provider erasure proof is implied by raw delivery.

For the taint gate, apply its migration before matching server code; old servers
must not serve tainted machines. Dropping the column loses permanent exposure
history and is not a safe rollback. Before rollback/restore, disable affected
workloads and retain taint tombstones. Deleting online recovery ciphertext is
not erasure of backups, provider disks or events.

Staging acceptance, including multi-user visibility, replay, secret canaries and
later-turn rehydration, is in [deployed checks](post-deploy-smoke.md#targeted-staging-checks).

### Help and literal arguments

Use `armada template --help` or `armada template <action> -h` at the
command boundary. A help-like token inside an operation is not a help request:
for example, `--prompt -h` supplies the literal prompt `-h`, and
`template create --file definition.json -- --help` supplies a literal template
name after the terminator. Malformed operations still fail validation rather
than silently showing help. No launch or definition handling changes otherwise.

### Vault help and literal arguments

For vars/secrets, long help follows the same token rules as short help: tokens
after `--` are literal operation arguments, not help requests. Option values
are left to the normal parser: `--file --help` is a missing-value error, not
a successful help response. Valid family/subcommand help remains available
before authentication or value input. Server validation still controls which
names/IDs are accepted; this does not broaden the vault's accepted names.
