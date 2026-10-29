# @armada/protocol

The V2 daemon/app wire contract. ESM, Node 22 or a browser; Zod is the only
runtime dependency. No V1 API, daemon imports, transport or I/O.

`bun run build` emits JavaScript and declarations in `dist/`. Consumers import
`@armada/protocol`; types are inferred from the exported runtime schemas.
`bun run test` builds and exercises the compiled package with Node's test runner.
Root installation builds the package so direct `bun test` also works on a clean
checkout. The root workspace glob already includes this package. Root lint, typecheck and
verify include it, and CI runs its Node tests before the repository's Bun suite.

## Messages

Each WebSocket text frame is one JSON object. All messages carry
`version: { major, minor }`; the initial wire version is **1.0**, independent of
application release numbers. Request `id` values correlate replies; clients keep
outstanding ids unique. Errors without an id concern the connection or an
uncorrelatable request. Schema parsing ignores additive object fields.

| Client request | Fields besides `type`, `version`, `id` | Server reply |
| --- | --- | --- |
| `projects.list` | — | `projects.result`: `projects` (`id`, `name`, GitHub `repository`, e.g. `example/repo`) |
| `project.subscribe` | `project`, `after` | `project.subscribed`: `project`, `subscriptionId`, `after` |
| `session.read` | `project`, `sessionId` | `session.result`: `project`, `sessionId`, `seq`, `events` |

A subscription acknowledges the requested exclusive cursor `after` (0 means
from the beginning), then emits `events` frames with `subscriptionId`, `project`,
`seq`, and `events`. `seq` is the inclusive high-water mark of the scanned log,
including empty batches. Reconnect with `after` equal to the last fully applied
frame's `seq`. A server must emit frames with nondecreasing cursors and events
strictly after the subscription's previous cursor. Per-frame validation checks
strict event ordering, the upper cursor bound and project isolation; tracking
previous frames belongs to the connection, not these stateless schemas.

Every event has `(seq, project, kind, at, actor, payload)`: a positive safe integer
sequence, project id, kind, ISO timestamp with a timezone, actor id and JSON
payload. Cursors are nonnegative safe integers. Global sequence gaps are allowed
because a log contains multiple projects. This package owns the event kinds and
payloads in `eventPayloadSchemas`, with `EventPayloads`, `EventInput` and
`FleetEvent` inferred from that vocabulary. `eventSchema` deliberately validates
only the open transport envelope, so an app can ignore kinds it does not use.

A session read returns that session's event history, in order, at the log cursor
`seq`. The daemon selects events belonging to the requested session; the wire
schema checks their envelope and project. A missing project or session returns
`error` with code `not-found`, rather than an empty successful session. This
lets consumers read session history without implementing the daemon's fold.
The other error codes are `invalid-message`, `app-too-old`, `daemon-too-old`,
and `internal`; `message` is a single human explanation.

## Admission and versioning

The daemon must call `admitRequest` before dispatching **every** request:

```ts
import { admitRequest } from "@armada/protocol";

// `input` is JSON decoded by the transport adapter.
const result = admitRequest(input);
if (!result.ok) {
  socket.send(JSON.stringify(result.error));
  if (result.close) socket.close();
  return; // never dispatch a rejected request
}
dispatch(result.request);
```

A lower client major yields only an `app-too-old` error whose message is exactly:

> Armada app is older than the daemon: update it

The adapter sends that error once and closes without executing the request.
Version is inspected before the request body, so an obsolete message shape still
gets this line. A higher client major similarly gets `daemon-too-old` and closes.
Invalid requests get `invalid-message` and are never dispatched.

A major change is breaking. Minor changes must be additive optional fields;
unknown message kinds still fail validation, so introducing a required operation
requires a major change or explicit feature negotiation in a later protocol.
Both sides accept minor differences within the same major. App consumers validate
with `serverMessageSchema` and check the server's major before applying frames;
a major mismatch requires reconnecting with a compatible app/daemon pair.

### Credentials (minor 1)

A local app sends `credentials.status` after connection to discover the saved
coordinator provider (`anthropic`, `openai`, or `null`) and storage type
(`os-keychain` or the explicit Linux/CI `file` fallback). Only an explicit form
submission sends `credentials.set` with `provider` and `key`. Both operations
answer `credentials.result`, containing status only: keys never travel back,
enter subscriptions, or become events. A dropped/unconfirmed write is never
replayed; reconnect queries status instead. The app keeps neither a key nor a
pending write body in its store or browser storage. A daemon below minor 1 still
serves the fleet; the app does not offer credential configuration on it.

Credential requests must go through admission and the daemon's private credential
dispatch, before project-scoped fleet dispatch. Do not log request frames or
backend errors. The transport accepts writes only on its loopback socket under
its existing trusted-origin check. There is no credential-read message.

## Folded snapshots (additive)

`project.subscribed` may include `snapshot: {seq,state}` on an initial
`after: 0` subscription. `state` carries the protocol's `ProjectTables`;
`seq` is its inclusive global cursor. Servers still send the event-history frame
so clients that fold locally continue to work. A client using the snapshot must
apply only events after the snapshot cursor. Replay subscriptions with a positive
`after` omit the snapshot and send only missed event batches. This optional field
adds no required operation or dependency on daemon types. The daemon validates
its JSON-normalized tables through `projectTablesSchema`, preserving extension
fields and key order. The wire schema accepts JSON so apps can read a subset of
the tables and remain compatible with additive changes.

An `events` frame may carry the same optional `snapshot`: the project's folded
state after that frame's events, at the frame's own cursor (`snapshot.seq` equals
`seq`; the schema refuses another). A server sends it on frames that carry events
and may leave it out of empty frames and of the history frame that follows a
snapshot-bearing `project.subscribed`. A client renders the daemon's fold from
these snapshots without folding, keeping the one at the highest cursor. Older
clients ignore the field; this app says so when events arrive without one.

Project rules are an additive `ProjectTables.rules: {revision,value}` slice. It is
optional when validating older snapshots; the current daemon always folds it,
with revision 0 and an empty value before configuration. `projectRulesSchema` and
`rulesStateSchema` own its routing/default, placement and policy contract. The
native coordinator tool derives JSON Schema from that same definition, and the
app reads it directly. Rules still use the existing `coordinator.checkpoint` kind
under the reserved `armada.tools` v1 format; no event vocabulary change is needed.

### A project's room (minor 2)

`src/chat.ts` carries the room's messages (THE-1996). A client sends them only to
a daemon whose `projects.result` says minor 2 or more (`CHAT_MINOR`); an older
daemon would refuse them as unknown, and the app says so instead.

| Client request | Fields besides `type`, `version`, `id` | Server reply |
| --- | --- | --- |
| `chat.read` | `project` | `chat.result`: `project`, `seq`, `coordinator` (one runs), `items` |
| `chat.send` | `project`, `requestId`, `body` | `chat.sent`: `project`, `requestId` |
| `owner.answer` | `project`, `item`, `choice`, optional `note` | `owner.answered`: `project`, `item` |

`items` is the conversation oldest first, its latest 200 when long: `owner`
(the owner's message), `coordinator` (its answer), `line` (its own short line,
said when the fleet moved, not in answer to the owner) and `tool` (`name`,
`input`, `output` (null while it runs), `failed`). The daemon derives them; the
app never reads pi's checkpoints. A message keeps its `requestId` until
admitted: sending it again after a drop is the same message, admitted once. Its
effect reaches every subscriber as the coordinator's `coordinator.checkpoint`
events; a client reads the conversation again when one arrives. `owner.answer`
answers an open `owner-request` of the project's inbox; anything else is
`not-found`, as is `chat.send` to a project without a coordinator.
