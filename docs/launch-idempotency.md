# Launch idempotency and external references

An embedding product (for example one sandbox per tender application) needs to
launch exactly one sandbox per business object and find it again. Two launch
fields serve that, on every ordinary Boat and Modal launch surface (#2568).
Docker launches use a different contract, described [below](#docker-launches).

| Surface | Exactly-once field | External reference |
| --- | --- | --- |
| `POST /api/v1/sandbox/launch` for Boat and Modal (and the `launch-sized-v1`, `launch-access-v1`, runtime variants) | `idempotencyKey`, 16–128 characters | `externalRef` |
| MCP `launch` / `launch_sized_v1` | `idempotencyKey`, 16–128 characters | `externalRef` |
| `POST /api/v1/templates/launch` | `requestKey` (required, see [templates](templates-cli.md)) | `externalRef` |

`externalRef` is opaque: 1–200 characters without control characters. Armada
stores it on the sandbox and never interprets it. It is **not unique**; use the
idempotency key for exactly-once. A malformed value is refused before any
provider allocation.

## Idempotency key

A key is scoped to the caller and organization.

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

Without a key the REST route behaves as before: every call launches. A server
without durable receipts, or a launch path that cannot pin its allocation
authority, refuses a keyed launch rather than launching without the guarantee.

## Docker launches

`POST /api/v1/sandbox/launch` with `"provider":"docker"` goes to the normal
Docker handler, which has its own list of accepted fields. It refuses `golden`,
`idempotencyKey` and `externalRef` with 400 `invalid_request`, so a Docker
sandbox carries no external reference and `sandbox/list` with `externalRef`
never finds it. Instead:

- `requestId`, a fresh UUID you generate and store before launching, is the
  sandbox ID and the replay key. The comparison uses the normalized request:
  spelling out a default such as `ttlSeconds` is not a change. A changed body
  returns `conflict` (409).
- `org` is the organization UUID. `hostId` names the Docker host, unless
  `snapshotId` names a Docker snapshot, which selects its own host.

The launch call returns once Armada admits the launch, normally with
`"status":"starting"` and no `promptId` or `conversationId`. A worker starts
the sandbox and sends the prompt afterwards. A replay with the same
`requestId` and body never launches twice:

- The replay reports the sandbox's current status, not the status of an
  earlier response. Until the worker publishes the launch receipt, a `ready`
  or `running` sandbox is reported as `starting`. A stopped, failed or deleted
  sandbox keeps that status.
- The recorded `promptId` and `conversationId` appear only after the worker
  publishes the launch receipt, and only when the launch sent a prompt.

After an uncertain Docker launch, poll `sandbox/status` with that UUID as
`id`. For a launch that sent a prompt, replay the same request and look for
`promptId` and `conversationId` rather than at the status. `starting` without
them means the launch is still pending. `stopped`, `failed` or `deleted`
without them is a separate outcome: the sandbox ended before the launch prompt
was sent, so no receipt will appear. Do not launch with a new `requestId`
until you know that the first launch failed or ended.
See
[Docker hosts](docker-host-daemon.md) for an example body.
The rest of this page covers Boat and Modal launches.

## Retry contract for an uncertain launch

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
