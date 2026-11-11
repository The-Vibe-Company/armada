# Template slice 4 staging acceptance

For #936. API/MCP only; no template UI/CLI management, secret bindings, grants,
routines or application-secret security guarantees. **Do not run against production.**
The operator must apply `20261111100000_launch_templates.sql` to disposable staging;
this PR does not apply or deploy it. Its timestamp is above main and the open-PR
migration filenames checked on 2026-11-11 (#928: 20261111020000,
#932: 20261111080000). Deploy the matching control server and rebuilt portable/native
runtime together: older Modal runners refuse the new bootstrap operation.

## Shared operations

Authenticated POST routes under `/api/v1/templates/`: `create`, `list`, `get`,
`publish`, `delete`, `launch`. They return no-store JSON. The dashboard-origin
proxy admits all six. The matching MCP tools are `template_create`,
`template_list`, `template_get`, `template_publish`, `template_delete`,
`template_launch`; they share the service and strict validation. Query parameters at the control service,
unknown fields and secret bindings are refused. The public proxy strips query
parameters before forwarding; they have no effect there. No raw environment override exists.

All inputs require `org` (UUID). Create additionally accepts `name`, `scope`
(`personal` or `org`) and `definition`. A definition is:

```json
{
  "goldenId": "<provider-specific-golden-uuid>",
  "provider": "modal",
  "harness": "codex",
  "model": "<supported-model-id>",
  "reasoningEffort": "medium",
  "connections": ["<exact-connection-uuid>"],
  "variables": [{"key": "APP_REGION", "variableId": "<readable-variable-uuid>", "version": 1}],
  "skills": ["<public-org/skill@exact-version>"]
}
```

Omit unused connections/variables/skills; omit model/effort to freeze the current
harness defaults. Optional `modelAccount: {id, version}` pins an account; otherwise
launch resolves the actor's existing user-over-org default and freezes its ID/version.
No silent fallback from a pinned account occurs. The revision stores connection IDs
only, plus the immutable provider binding.
At launch admission, currently connected tool grant versions/generations resolve into
the immutable manifest; ordinary OAuth refresh before admission needs no republication.
Changes after that claim fail admission instead of silently substituting a new grant.
Variables require explicit versions; changes require a new revision.

List uses `{org}`. Get uses `{org,id,revision?}` (default current). Publish uses
`{org,id,expectedRevision,definition}` and always creates a new immutable revision;
stale publication is 409. Delete uses `{org,id,expectedRevision}` and tombstones the
header, preserving revisions and request history. No in-place scope promotion exists.
Launch uses `{org,id,revision?,requestKey,prompt?,ttlSeconds?,size?,repo?}`. Only the
four documented launch overrides are allowed. `requestKey` is a required 1–128
character ASCII identifier (`A-Z`, `a-z`, digits, `.`, `_`, `:`, `-`).

Launch returns request state/ID, sandbox ID and its frozen manifest. On success it
also returns provider/sandbox IDs, prompt/conversation IDs and sandbox status.
Readable values intentionally appear in manifests: **they are not secrets**.
Personal metadata is owner-only with current membership; org metadata is visible to
current members and only admins mutate it. Org templates cannot bind personal
resources; unspecified model accounts intentionally resolve per launching member.
An org environment publisher/admin can inspect configuration delivered there; a
personal variable is not runtime-confidential from that administrator.

## Exact readable-value transport (V1-readable-env)

Values resolve at launch, not golden build. They never enter fork environment,
repository pull/init commands, command interpolation or checkout files. After
repository/init, skills and MCP preparation, a final-start admission rechecks
membership/reference versions, then calls a trusted provider bootstrap:

- **Modal:** authenticated private runner `configureReadableVariables` operation.
  The runner validates the allowlist/limits and merges into only the selected native
  driver's future process environment; ordinary exec has its separate environment.
  The operation is not stored in request replay journals and does not register
  values as secrets. A different configuration for the same harness/incarnation
  is refused; an identical live configuration is acknowledged without reapplying it.
  New physical incarnations receive the same frozen manifest through
  the server's authorized before-prompt lifecycle hook.
- **Boat:** pinned SSH stdin delivers JSON to a fixed bootstrap, not argv or VM
  exec journals. A root-owned readable JSON file is atomically installed under
  `/run/armada-readable-variables/<harness>.json`, outside checkouts. The managed
  native harness wrapper reads it only when starting the selected native workload;
  unrelated exec does not inherit it. Before-prompt rehydrates it after resume.
  The file has mode **0644 (world-readable)**: unrelated exec does not inherit the
  environment, but any sandbox user/exec can intentionally read the file. This is
  non-secret configuration, not a confidentiality boundary or a secret store.
  A fixed live file/wrapper digest probe skips reinstall/SSH when unchanged; clearing
  `/run` or restoring a new VM forces re-delivery, without a process-local cache.
  Temporary SSH key material is removed locally; authorized-key cleanup is attempted remotely.

Both paths support empty/multiline values, literal shell syntax, at most 64 bindings,
8 KiB UTF-8/value and 64 KiB aggregate. Reserved/infrastructure names, NUL, invalid
Unicode and duplicate keys are refused. Values may be printed or transformed by
an agent and cannot be recalled. This does not enable application-secret delivery.

## Required coordinator checks

1. On the **Modal staging golden**, create two distinguishable readable variables
   (one empty), select two known connected tools/workspaces, select a model/effort,
   and create a personal template. Also exercise shared org publication as admin.
   Use only disposable configuration, never application secrets.
2. Launch with a prompt asking the intended harness to confirm the two exact tools,
   model/effort and variable values. Inspect returned manifest/account, sandbox
   model fields and actual native environment. Confirm empty and multiline values
   survive without shell expansion. Confirm values are absent during golden build,
   pull/init and unrelated sandbox exec environments, but present in harness children. Repeat
   after idle launch → first send, stop → send/restore, and on Boat staging. On Boat,
   explicitly confirm unrelated exec can read the world-readable JSON file; only
   environment inheritance, not value confidentiality, is excluded.
   Edit the readable variable, delete/tombstone its template, refresh the tool token,
   rotate the model credential or change the member's role: an already admitted
   readable sandbox keeps taking later prompts with the frozen values (subject to
   normal current sandbox/model/tool authorization). Confirm re-delivery after a
   new Modal runner incarnation and after Boat `/run` is cleared.
3. Exercise owner, other member, admin and outsider identities. Personal templates
   and revisions must be invisible to peers/admins; org members can launch but
   cannot publish/delete. Remove membership and retry: denied. Direct JWT probes
   cannot write any of the three tables, anon cannot select, personal revisions
   stay private, and request/manifests are visible only to their actor.
4. Publish with matching then stale `expectedRevision`; old revision remains unchanged.
   Try a personal ref on an org template, stale variable/account, missing/disabled/
   revoked tool, removed golden or provider remap: explicit value-free refusal
   before allocation. Revoke a reference during init: no variable hydration or
   first prompt; confirm compute is stopped. Verify no secret binding is accepted.
5. **S4-rebuild-admission**, both providers: block an admitted allocation on snapshot
   A, rebuild the same golden to eligible B, and inspect manifests. In-flight
   allocation stays on A (or fails unavailable if A was retired); same-key replay
   cannot allocate B. A new key follows B without template republication. An
   ineligible/missing environment must not fall back to another ID/provider.
6. Repeat same key/body concurrently, after lost HTTP response and control restart:
   at most one allocation. Changing body with the same key is 409. Keys are scoped
   to actor/org. Simulate unknown provider fork outcome: the request remains
   `reconciling`; retries return its record and never fork or resend a prompt.
7. Confirm all six operations through both the authenticated public-origin proxy
   and MCP, including stale publication, query/unknown-field refusal and no bearer.

## Later-turn admission and ordinary-prompt cost

Later readable preparation checks **current caller membership and sandbox interior
access only**, then delivers the copied manifest values. It never rereads current
template/golden/variable/grant/account versions or the original actor epoch. Deleting
or editing those source objects does not retroactively invalidate readable config.
Existing independent sandbox/model/tool policies still apply to their own operations.

The existing MCP lifecycle authorized sandbox read resolves an immutable template
request hint through an indexed lookup. Only a nonempty readable manifest triggers
preparation. Ordinary non-template prompts add **no database round trips or SSH**;
there is no stale negative cache that could miss a later template admission.

## Conservative recovery limits

Request keys and immutable manifests have no expiry/automatic deletion: tombstones
must not turn retries into new work. The first claim freezes revision/hash, golden
config/provider/snapshot (including Modal binding), tool generations/versions, resolved
account ID/version, variable ID/version/copied readable values, actor/membership epoch
and request key before any fork. The winning claim transaction also acquires the
existing golden-operation fence for that exact snapshot/master; later provider or
credential awaits cannot invalidate it merely because a rebuild publishes B. The
immutable request keeps its historical fence ID after the live fence is released.
Confirmed no-allocation/registered-child outcomes release the fence; ambiguous
allocation or a crash retains it for reconciliation. The key digest is canonical over the non-secret
request; prompts are not copied into generic request metadata.

There is **no automatic ambiguous-request recovery or retry worker** in this slice.
A crash in `claimed`/`allocating` or any possibly allocated/start-failed outcome stays
recorded and is never automatically dispatched again. `reconciling` is not a success
or proof of absence. Operators must inspect the request's logical sandbox ID, any
registered provider ID and provider ownership labels before cleanup. Do not delete
request rows or invent a new key as a recovery action while the old outcome is
unknown. Successfully returned results are durably replayed unchanged; no new
variable value, account, snapshot or prompt is substituted on retry.
