# Launch idempotency and external references

An embedding product (for example one sandbox per tender application) needs to
launch exactly one sandbox per business object and find it again. Two launch
fields serve that. Docker has its own [receipt lifecycle](#docker-launches).

| Surface | Exactly-once field | External reference |
| --- | --- | --- |
| `POST /api/v1/sandbox/launch` for Boat and Modal (and the `launch-sized-v1`, `launch-access-v1`, runtime variants) | `idempotencyKey`, 16–128 characters | `externalRef` |
| `POST /api/v1/sandbox/launch` for Docker | `idempotencyKey` or legacy `requestId` | `externalRef` |
| MCP `launch` / `launch_sized_v1` | `idempotencyKey`, 16–128 characters | `externalRef` |
| `POST /api/v1/templates/launch` | `requestKey` (required, see [templates](templates-cli.md)) | `externalRef` |

`externalRef` is opaque: 1–200 characters without control characters. Armada
stores it on the sandbox and never interprets it. It is **not unique**; use the
idempotency key for exactly-once. A malformed value is refused before any
provider allocation.

## Idempotency key

A key is scoped to the caller and organization. The following receipt rules
apply to ordinary Boat and Modal launches.

- Same key, same request: the recorded answer, with the same sandbox id. No
  second fork. This holds only while the request still passes launch
  preflight, which runs before the receipt is read: the same snapshot is still
  visible to the caller under the same name and provider, its provider account
  is still configured, and the server can pin an allocation authority.
  Otherwise the replay returns the preflight error (for example `not_found`
  after the snapshot was removed). The snapshot id is part of the request, so
  a snapshot recreated under the same name yields `conflict` (409). Neither
  error is the original outcome.
- Same key, any different field (including `externalRef` or `prompt`):
  refused with `conflict` (409). Nothing is launched.
- Same key after a terminal refusal recorded under it (bad configuration, no
  credentials, a non-mutating provider refusal): the same refusal. Correct the
  cause and use a new key.

For Boat and Modal, every unkeyed REST call launches. A server
without durable receipts, or a launch path that cannot pin its allocation
authority, refuses a keyed launch rather than launching without the guarantee.

## Docker launches

Send exactly one of these fields with `"provider":"docker"`:

- `idempotencyKey` is a 16–128 character key scoped to the caller and
  organization. Armada derives the sandbox ID using the server encryption key,
  so keep that key consistent across servers handling retries.
- `requestId` is a caller-chosen UUID used by existing clients. It is also the
  sandbox ID.

Docker has a separate key namespace from Boat and Modal. Retain the selected
provider when retrying a launch.

For either field, replay the same launch inputs. After admission, a changed
normalized request, including a changed `externalRef`, is refused. For example,
spelling out the default TTL is equivalent to omitting it. A refusal before
admission does not reserve the key. Set `externalRef` to find an admitted
sandbox with `sandbox/list` even if the original response was lost.

Select the organization by name or UUID. You can omit it when you belong to a
single organization or use an org-scoped token. For a scoped token, an explicit
organization must be its UUID. In the CLI, pass `--agent` for Docker launches
as you would for golden launches. A `hostId` selects a Docker host. A
`snapshotId` selects a Docker snapshot and its host.

The launch call returns once Armada admits the launch, normally with
`sandbox.status: "starting"` and null `promptId` and `conversationId`. A worker starts
the sandbox and sends the prompt afterwards. A replay with the same
key and normalized inputs never launches twice:

- The replay reports the sandbox's current status, not the status of an
  earlier response. Until the worker publishes the launch receipt, a `ready`
  or `running` sandbox is reported as `starting`. A stopped, failed or deleted
  sandbox keeps that status.
- The recorded `promptId` and `conversationId` appear only after the worker
  publishes the launch receipt, and only when the launch sent a prompt.

After an uncertain Docker launch, replay the original request or poll
`sandbox/status` with the sandbox ID when it is known. For a launch that sent a prompt, replay the same request and look for
`promptId` and `conversationId` rather than at the status. `starting` without
them means the launch is still pending. `stopped`, `failed` or `deleted`
without them is a separate outcome: no receipt will appear, and the prompt
outcome is uncertain. The sandbox may have ended before the launch prompt was
sent, or after the worker sent it but before the receipt was recorded, in which
case the agent may already have acted on it. Inspect the original sandbox's
status and logs before you repeat the work. Do not launch with a new
key until you know that the first launch failed or ended.
See
[Docker hosts](docker-host-daemon.md) for an example body.


## Retry contract for an uncertain Boat or Modal launch

A timeout, a dropped connection or `outcome_unknown` (503) means the sandbox may
or may not exist. Never retry with a new key: that is how duplicates happen.

1. Retry with the **same key and the same body**. A completed launch answers
   with its recorded sandbox; a still-unknown one answers `outcome_unknown`
   again and names the receipt id, which is also the sandbox id it would have.
   A preflight error such as `not_found` says nothing about the first launch;
   keep the key and continue with the next steps.
2. Look the sandbox up by reference: `sandbox/list` with `externalRef` returns
   every sandbox you own or administer carrying it, including a launch whose
   answer was lost after the sandbox was recorded.
3. If neither shows it and an `outcome_unknown` or `conflict` answer named a
   receipt id, inspect it as the launching user with MCP `launch_receipt`
   (`{"id":"<receipt UUID>"}`, plus `org` set to the organization UUID when
   you belong to several). It lists
   provider allocations labelled with that id, using the provider binding
   recorded on the receipt, so a removed snapshot does not prevent the lookup.
   An empty lookup is not proof of no allocation; keep the key and ask an
   operator rather than relaunching.
4. If you never received a receipt id (the first answer was lost and the replay
   fails preflight, for example with `not_found`, or the receipt itself could
   not be read), there is no self-service
   lookup. Keep the original key, do not relaunch, and escalate to an operator
   with the organization, the key and the `externalRef`.

Template launches follow the same rule with `requestKey`: a replay answers the
recorded state (`succeeded`, `failed`, `reconciling`), and `reconciling` is
never re-dispatched.

## Reading the reference back

- `sandbox/status` (and MCP `status`/`wait`) return `externalRef` when set.
- `sandbox/list` returns `externalRef` and accepts it as a filter. Both are
  interior-only: a member who cannot open another member's sandbox sees the row
  without its reference, and filtering by reference never matches it.
- The launch answer returns it too.

Signed [outbound webhooks](outbound-webhooks.md) include `externalRef` in
each payload, with null when the sandbox has no reference.

## Canonical launch API

The [OpenAPI contract](openapi.json) describes the validated request variants for
`POST /api/v1/sandbox/launch`: golden, explicit Boat runtime, explicit Modal
runtime from a golden or pinned template, Docker host and Docker snapshot, each
with its supported replay fields. Unknown fields are rejected. Use
`ttlSeconds` and `reasoningEffort` for REST launch requests. Provider-specific
settings and server opt-ins still apply.

Golden and Docker launches share an envelope. Read the placement and Armada ID
at `sandbox.provider` and `sandbox.id`. The `golden` record is null for Docker.
`promptId`, `conversationId`, `runtime` and `helper` are null when unavailable.
CLI JSON includes `sandbox.id` and the top-level `id` alias on all three
providers. The CLI's `golden` field remains a name or null.

## Launch route compatibility

For explicit runtime launches from a golden, send the selectors to `POST /api/v1/sandbox/launch`.
Use `runtimeVersion: 1` and `boatRuntime: true` for Boat. Use `runtimeVersion: 1`,
`provider: "modal"` and `runtimeTransport: "dialout"` for Modal. The existing
runtime admission checks and server opt-ins apply on both the canonical and
compatibility routes. For a pinned Modal template, send the same Modal selectors
with `org` (UUID), `id`, `revision`, `requestKey` and the template's `harness` to
`sandbox/launch`. When admission records a request, it returns a durable template
launch receipt, including the frozen manifest on success. Replay the same body
and request key to recover that receipt, and use its top-level `id` for sandbox
operations. A pre-admission refusal has no request ID or sandbox ID. Ordinary
template launches continue to use `templates/launch`.

For REST extensions, use `ttlSeconds` on `POST /api/v1/sandbox/extend`
as well. The server accepts the older `ttl_seconds` spelling for existing
clients. Send only one field.

| Compatibility route | Known released or external callers |
| --- | --- |
| `sandbox/launch-sized-v1` | Released CLI, dashboard and iOS builds with sizing or repository selection |
| `sandbox/launch-access-v1` | Released CLI and dashboard builds with scoped access, and older scoped-access probes |
| `sandbox/launch-runtime-v1` | Older Boat runtime probes and direct API integrations |
| `sandbox/launch-modal-runtime-v1` | Older Modal runtime probes, direct API integrations and older explicit pinned Modal template callers |

The CLI, dashboard, iOS app and direct golden smoke probes now send these
selectors to `sandbox/launch`, including the Modal readable-variable probe's
explicit pinned-template mode. Keep launch aliases available for at least 90 days
after the first release carrying the first-party golden launch migration. Audit
remaining released-client and external usage before retiring the aliases.
