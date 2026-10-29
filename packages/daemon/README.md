# Armada daemon store

`@armada/daemon` is the V2 daemon's private workspace package. It runs on Node
22.19+ (native TypeScript support), uses `node:sqlite`, and has no V1 imports.
The root `packages/*` workspace glob includes it.

```ts
import { EventStore } from "@armada/daemon/store";
import { fold } from "@armada/daemon/fold";

const store = new EventStore("/path/to/fleet.sqlite");
const event = store.append({
  project: "orchard",
  kind: "hold.opened",
  at: "2030-01-01T10:00:00Z",
  actor: "Mira",
  payload: { id: "release-check", reason: "Wait for deployment" },
});
const fleet = fold(store.readSince(0));
const later = store.readSince(event.seq, "orchard");
store.close();
```

The caller supplies the project, timestamp and actor. SQLite assigns a global,
monotonically increasing `seq`; replay uses `seq > cursor`, ordered by sequence,
even when timestamps repeat or arrive out of order. A project filter keeps the
global sequence, so gaps are expected. WAL and full synchronous commits preserve
the log across process restarts. Updates, deletes and replacing existing rows
are refused by triggers. Close the store before copying the database and its WAL
for a backup; live SQLite backups require SQLite's backup API.

`fold` takes a complete log, or a complete project-filtered log from sequence 0.
It does not accept incremental batches as a replacement for prior history.
It returns the last sequence and tables keyed by project: ticket and PR
observations, the latest generation of each ticket's session (including merged
and released sessions), those sessions grouped by state, the open inbox, the
active FIFO merge queue, open holds, and all validations with their first
recorded decision. A decided validation stops waiting for the owner even before
the worker reports its next phase. Answers, queue refusals/cancellations/confirmed merges, and
hold clears remove the corresponding active row; history stays in the log.
Conversation and checkpoint events are stored without changing fleet rows.

Claim session IDs identify a generation and must be unique within a project.
Each claim also carries a positive integer `generation`, assigned monotonically
per ticket by the launcher. Only a higher generation can replace the current
session, including when an older claim arrives late for the first time. Tracker
sessions use generation 0. Timestamps never decide generation order.
Reports, heartbeats, releases and merge confirmations name that generation;
stale generations cannot change the current session. Request/queue/hold/validation
IDs identify one operation and should not be reused. A tracker observation may
create a synthetic `tracker:<ticket>` session before a local claim exists;
a local claim takes precedence over later tracker phase observations. PR reads
enrich CI and conflict state; `merge.confirmed` records a local merge outcome.
The copied phase/flow rules name their core source in `src/rules.ts`.

The event vocabulary and folded-table schemas live in `packages/protocol`.
`src/events.ts` re-exports its event types for daemon adapters; `fold` consumes
those shared contracts and the server validates its serialized tables with the
protocol schema. The wire envelope remains open to kinds a reader does not use.
Nothing in the app should import the daemon.

Run `bun run test:daemon` from the repository root for Node's test runner. The
same tests run in the Bun suite; `bun run verify` and CI also exercise native
Node SQLite explicitly. Store tests use disposable database files; fold tests
use invented tickets and people without I/O.

## Credential boundary

`keychain.ts` is the host's only secret-read gateway. `systemKeychain()` uses
`@napi-rs/keyring` (macOS Security framework) on macOS, without subprocess
arguments. A locked or unavailable Keychain fails closed; it never creates a
plaintext fallback on macOS. Linux/CI explicitly uses private files under
`$XDG_CONFIG_HOME/armada/desktop/credentials` (default `~/.config`): mode 0700
directory, mode 0600 files, no symlink reads, atomic replacements. Keep that
folder out of backups/exports of fleet events. Other platforms are refused.

The reserved services are `armada.coordinator` (account `coordinator`, one
atomic provider/key entry), `armada.linear` (account is the project id), and
`armada.github` (account `github`). Use `Keychain.read` and `write` for provider
credentials; `setCoordinator`, `coordinator`, and `status` handle the model key.
Backend errors are replaced by fixed messages without a cause. Consumers and
plugins must not import `secrets/*` or a native keychain module. Tests inject a
`FakeKeychain`; test keys are generated at runtime rather than stored in fixtures.

`dispatchCredentials` runs after `admitRequest`, before project-scoped dispatch.
It returns status or a fixed error and has no event-store/logger dependency. The
server serializes credential reads/writes across connections (at most 32 pending)
and drains accepted operations on shutdown. Embedders can inject `keychain` into
`startServer`; the production default is `systemKeychain()`.

The app's Plugins screen (THE-2019) goes through `dispatchPlugins`
(`src/server/plugins.ts`), also after admission and serialized the same way, given
a `PluginHost` by `startServer`'s `plugins` option: the boot's catalog, what it
loaded and the settings it read (`loadPlugins` returns them), the app
configuration's path and a keychain. Every answer is `plugins.result`, the whole
catalog as saved now. A switch and a contribution's config are written with
`updateAppConfig` (`setPluginEnabled`, `setPluginConfig`), and a config is first
checked with the loader's own rule (`validateContribution`). A secret is accepted
only under a name the plugin declares, written to `armada.plugins`, and reported
as set or missing. `restartRequired` compares the saved switch and config with the
boot's. `daemon.restart` sends `daemon.restarting`, then calls `startServer`'s
`restart`; `armadad --restartable` (the desktop shell's flag) closes and exits
with code 75 for the shell to start it again. Without `plugins` or `restart` those
requests answer `not-found`. `test/plugins-server.test.ts` covers this side.

## Local server (`armadad`)

Build the browser app with `bun run --cwd packages/app build`, then run the
Node daemon (Node 22.19+):

```sh
node packages/daemon/src/server/main.ts --database .context/fleet.sqlite --projects .context/projects.json
```

The project catalog is a JSON array, for example
`[{"id":"orchard","name":"Orchard","repository":"example/orchard","programRoot":"SEED-1"}]`.
`programRoot` is the Linear program's root issue identifier; omit it for a
GitHub-only project. Optional `phaseGroup` names the Linear phase label group
(default `Agent phase`). These fields configure daemon readers, not the public
project protocol.
The daemon binds `127.0.0.1`, uses an OS-assigned port unless `--port` is given,
and prints one JSON readiness line with `url`, `wsUrl`, and
`readers: [{project, tracker, forge}]` (booleans indicating which readers started).
Readiness means the listener and readers started, not that their first reads
finished. Open `url` in a browser;
Electron can read the same line to open its window. `SIGINT` and `SIGTERM` close
readers first (canceling polls and active reads), then connections and SQLite. `--static-dir` overrides `packages/app/dist`; a missing
build answers 404 while WebSocket requests still work. Static assets include
content types and HEAD support; HTML navigation falls back to `index.html`.
Paths and symlinks cannot escape the build directory.

Boot composes the existing `TrackerPoller` and `GithubReader` in
`src/server/readers.ts`. Each project has independent polling schedules (30
seconds after completion); both append through the very same store the server
subscribes to. GitHub correlates branches with ticket IDs already in that
project's log, including tickets read after boot, on subsequent reads.
Credentials are preflighted at startup: Linear uses the `readLinearKey` accessor
with a host `LINEAR_API_KEY` override, falling back to the shared
`systemKeychain().read("linear", project)` gateway. GitHub uses `GITHUB_TOKEN`,
then the shared keychain / `gh auth token` accessor. No provider reads the
environment itself. A missing
credential skips only that reader and emits one fixed, credential-free stderr
line per project/reader. Restart after supplying a missing key. Provider failures
retain the existing log and retry on the reader's next scheduled tick; neither
network reads nor credential lookup run in a protocol handler.

Embedders import `startServer` from `@armada/daemon/server`, supplying a store and
catalog; it returns `{url, wsUrl, close}`. The caller owns the store and closes it
after awaiting the server's idempotent `close()`. Adapters must append through
that same EventStore instance: this is one daemon's single writer, not a watcher
for external SQLite writers. `store.subscribe()` notifies after a committed
append, and `store.sequence` reads the global committed cursor. A throwing
observer is detached so it cannot turn a committed append into an apparent
failure. The server detaches its observer on close or a bind failure.

WebSocket text frames at `/` use `@armada/protocol`. Every request is admitted
before dispatch. List-projects reads the catalog; unknown projects/sessions
return `not-found`. A session read returns the events that explicitly name its
session ID, in order, at the global log cursor. Subscription acknowledgments
carry an optional `snapshot: {seq,state}` on `after: 0`: `state` is that project's
`ProjectTables` from the pure fold, including empty tables for an empty project.
The daemon also sends the initial event history for clients that fold locally.
A snapshot consumer should ignore events at or before the snapshot's cursor.
Every later frame that carries events carries the project's refolded state too
(`snapshot`, at the frame's cursor), so the app renders the fold without
folding; empty frames and the history frame right after a snapshot carry none.
Each such frame folds the project's log from the start, as `fold` requires, once
per project per flush, shared by the sockets.
A reconnect with a positive `after` omits the snapshot and replays only later
events, followed by live commits. Re-subscribing replaces the prior subscription
for that project on that socket. Other project commits emit empty batches that
advance the global cursor without leaking their events. A cursor ahead of the
log is refused, preserving any existing subscription.

There is no polling or wall-clock ordering. Registration and replay run
synchronously against SQLite, and every subscription reads from its own cursor,
preventing a gap between replay and live delivery. Commit notices coalesce into
one flush per microtask: a burst of appends in one task (a tracker's read) sends
each subscription one frame, with one fold per project. Disconnects discard connection state; durable sequence replay
works across daemon restarts. Slow clients with more than 8 MiB already queued
are disconnected and can replay. Requests are limited to 1 MiB. The local server
requires its bound Host header and permits absent (native client) or same-origin
browser Origin headers; `allowedOrigins` explicitly admits a separate trusted
dev app. Do not expose this unauthenticated local endpoint on a remote interface.

`test/server.test.ts` owns transport coverage using real SQLite, OS-assigned
loopback sockets and message/close events, including process readiness/shutdown.
It never sleeps, polls a clock, or contacts an external service.

## Durable coordinators

`startServer({ store, projects, coordinators })` opens one coordinator per configured
project and resumes its pending tasks before returning. Each configuration supplies
`{ project, models, model, tools?, now?, setTimer?, onReport? }`: `models` is the caller's
pi-ai SDK `Models` collection (or a getter), `model` is `{provider, modelId}`. The
server returns a `coordinators` map of `{harness, conversation}` handles; submit input
with a stable `requestId` using pi-durable's conversation API. Its idempotent
`close()` stops all harnesses before the caller closes the shared EventStore.
Unknown or duplicate coordinator projects are refused. Configuration is optional:
the standalone CLI starts without a model until the model-plugin boot path supplies
one. No provider, key lookup or environment credentials are constructed here.

`@armada/daemon/coordinator` exports the lifecycle manager for other daemon hosts,
the prompt and tool contract. `coordinator/system.md` adapts the V1 coordinator
SKILL/MERGE/REFERENCE policies to the thirteen native tools. Tool implementations
supply pi-durable `ToolRegistration` objects keyed by `CoordinatorToolName`, with
their own schemas and structured facts/refusals. Missing tools return
`tool_unavailable`. All tools execute sequentially for the project's single writer;
replay defaults to unsafe unless an implementation explicitly declares it safe.
THE-1994 supplies real tools; THE-2017 supplies model plugins, and THE-1996 adds chat
requests. Those paths need not change the storage contract.

The room's requests (THE-1996, `src/server/chat.ts`, protocol minor 4) are answered
after admission, one reply each. `chat.read` reads the conversation through pi-durable's
public `conversation.entries` (newest 200 entries) and the project's `coordinator.message`
events, never pi's storage writes: `pi.user` and `armada.owner-answer` inputs are the
owner's, assistant text is an answer after the owner spoke and the coordinator's own
`line` after any other input, each tool call is paired with its result (cut at 8 KiB;
`failed` on an error or facts saying `ok: false`). `chat.send` submits pi input with
the app's `requestId`, so a retry is one input; mid-run it steers (placed after the
current tool round). The checkpoint it commits is the event subscribers receive. A
failed model turn reads as a line saying so. `owner.answer` folds the project, appends
`inbox.answered` (actor `owner`) for an open `owner-request` in the same synchronous
step, then awaits handing the answer to the coordinator as an `armada.owner-answer`
input keyed by the item. If that fails it says so; the same answer again tells the
coordinator again (pi admits it once), while a different one is refused.
Without a coordinator, `chat.read` answers the log's lines with `coordinator: false`
and `chat.send` refuses with one line. `test/chat-server.test.ts` runs them over a
file log and a faux model, through a restart.

Pinned pi-durable 1.4 owns its scheduler directly over pi-ai; pi-agent-core is a
separate non-durable agent loop, so nesting it would create a second scheduler.
The custom Storage adapter uses pi's public `MemoryStorage.prepareCommit` to validate
and detach mutations. Each complete batch is one `coordinator.checkpoint` event
(`checkpoint.format = "armada.pi"`, `version = 1`, `type = "commit"`, `seq`, `writes`).
An ID reservation is a checkpoint with `type = "id"` and `id`, preserving unused IDs
across reopen. Batch sequences are local to pi; the outer event `seq` remains the
global fleet replay cursor. Other projects and non-pi checkpoint formats are ignored;
unsupported versions of this format refuse startup rather than discard history.
Append succeeds before the in-memory projection advances. Reopening folds the
project's checkpoints back through pi's reference storage, including task state,
entries, documents and deduplicated submission receipts. No second database or
conversation file exists. This first adapter retains the pi projection and replay
history in memory; memory and restart time grow with conversation history.

One daemon process owns the store. In-process duplicate opens of a project's
coordinator storage are refused, including through a second manager. Use that same
EventStore for all writes so subscribers receive committed checkpoint events too.
A completed model turn/tool result is reused on recovery. An uncommitted model
request can be retried. A process crash during an external tool effect is **not**
exactly-once: pi retries only explicitly safe tools; unsafe interrupted calls become
error results. Tool writers must use stable call IDs/idempotency for external writes.
Never put secrets in prompts, arguments, outputs or checkpoints.

`test/coordinator.test.ts` runs the actual Node server with an injected faux pi-ai
model in a child process, SIGKILLs it at deterministic model/tool gates, and reopens
the same SQLite log. It proves three model turns, one tool call, input deduplication,
preserved transcript/log prefix, and safe handling of interrupted unsafe effects.
No external network, key or wall-clock sleep is used. The prompt/tool inventory is
checked independently. The adapter's own test covers disk replay, project isolation,
durable ID allocation and failed-write atomicity. Storage compatibility findings are
recorded on THE-1984 before loop implementation.
