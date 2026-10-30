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

The app's Providers section in Settings (THE-2019, moved by THE-2069) goes through `dispatchPlugins`
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
`[{"id":"orchard","name":"Orchard","repository":"example/orchard"}]`.
Optional `tracker` and `forge` select registry kinds (defaults `linear` and
`github`). A disabled or refused plugin has no provider, so that seam does not
start. Configure provider-specific project metadata in the app configuration
(`ARMADA_APP_CONFIG`, otherwise `$XDG_CONFIG_HOME/armada/config.json`):

```json
{
  "plugins": [
    { "id": "linear", "config": { "tracker": { "linear": {
      "projects": { "orchard": { "programRoot": "SEED-1", "phaseGroup": "Agent phase" } }
    } } } },
    { "id": "github", "config": { "forge": { "github": {
      "projects": { "orchard": { "repository": "example/orchard" } }
    } } } }
  ]
}
```

Both plugins are enabled by default. A project omitted from a provider's map
is outside its scope and causes no requests. `programRoot` and `phaseGroup` in
the old project catalog are accepted for compatibility but no longer configure
readers; move them into the Linear plugin's project map above. GitHub's map is
also explicit so the plugin never needs host internals to resolve a repository.

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

Boot reads tracker and forge providers only from the plugin registry in
`src/server/readers.ts`. Each project/seam has an independent polling schedule
(30 seconds after completion), an abort deadline, and one outstanding read.
Providers append through `ctx.events` to the same store the server subscribes
to. GitHub correlates branches with ticket IDs in that project's log, including
arrivals after boot. Neither network reads nor credential lookup runs in a
protocol handler. Read failures leave existing observations intact, log a fixed
credential-free diagnostic and retry on the next tick.

Plugins request only their declared `LINEAR_API_KEY` or `GITHUB_TOKEN` through
`ctx.secrets`. The host gateway accepts those environment overrides and the
plugin keychain entries (`armada.plugins`, account equal to the secret name);
GitHub also retains the owner's `armada.github` / `github` entry. If no GitHub
secret is available, the plugin runs bounded `gh auth token`. Linear no longer
reads project-keychain entries directly: save its key as the declared plugin
secret. No provider imports the host keychain, store or server implementation.

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
current tool round), or with `whenBusy: "queue"` waits for the run's end (pi's
`followUp`, THE-2052). The checkpoint it commits is the event subscribers receive. A
failed model turn reads as a line saying so. `owner.answer` folds the project, appends
`inbox.answered` (actor `owner`) for an open `owner-request` in the same synchronous
step, then awaits handing the answer to the coordinator as an `armada.owner-answer`
input keyed by the item. If that fails it says so; the same answer again tells the
coordinator again (pi admits it once), while a different one is refused.
Without a coordinator, `chat.read` answers the log's lines with `coordinator: false`
and `chat.send` refuses with one line. `test/chat-server.test.ts` runs them over a
file log and a faux model, through a restart.

The session page's requests (THE-2045, `src/server/session.ts`, protocol minor 6) go
through the same `Workers` as the coordinator's tools, never to a runtime directly.

- `session.release` checks that the fold's current session is the named generation and
  still runs (not a V1 `tracker` session), then calls `Workers.stop`: the
  generation-fenced stop the merge uses, which releases and disposes a clean workspace.
- `session.output` answers `Workers.observe` (the masked reply), cut to its last 200
  lines without control sequences.
- `owner.answer` on a worker's `question` applies the guards of the coordinator's
  `inbox.answer`: the question is open, its worker claimed it, still runs, and the
  question is not from an earlier claim. It delivers the answer through
  `Workers.answer`, keyed `owner-answer:<item>`, then records `inbox.answered`
  (actor `owner`) and tells the coordinator as for an owner request.

Each refusal is one line. `test/session-server.test.ts` runs them over the real server
on a fake runtime (`test/support/fake-worker.ts`).

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

## Local worker plugins

The bundled `node-local` (`node.local`) and `claude` (`runtime.claude`) providers
run the official worker CLI. Add an absolute `checkout` path to each local
project catalog entry; `repository` remains its GitHub identity. The app's
plugin configuration may set `node.local.workspaceRoot` (defaults to Armada's
OS app-data directory), `transport: "auto" | "pipe" | "pty"`, and Claude's
`command` / `args`. Auto/PTY use the host's `script` facility when a terminal
exists and fall back to pipes when headless. Claude uses `--print` with streaming
JSON stdin/stdout so later messages stay in one CLI process. Armada never reads
the CLI's subscription credentials.

`worker.launch({ticket, branch?, brief?})` selects the first matching label route
or `defaultRoute`, and `placement.workers` selects the node kind from the same
boot registry. Natural-language `when` routes require their one-based `rule`
number and a `reason`. Missing providers, missing label evidence, closed tickets,
active generations, missing ready labels, parked tickets, open blockers and the configured worker cap refuse before launching. Unconfigured projects use `node.local` (the `node-local` plugin) and `runtime.claude` with the CLI’s default model; explicit unavailable providers and a null default route refuse. The tracker supplies the suggested branch and full ticket/parent/comment/blocker evidence for the host-built brief; optional `brief` adds coordinator notes. Plans require approval unless `policy.plans` or the ticket’s plan-approved label permits them; needs-plan-approval wins (or the configured `approvalLabel`).
`worker.message({ticket, session?, message})`, `worker.relaunch({ticket, session?, reason})`
and `worker.stop({ticket, session?, reason})` pin the current generation when admitted;
include the inspected `session` to refuse a target changed since inspection. Relaunch
preflights before stopping, releases only that old generation, and reuses its branch
and workspace (including uncommitted files and the existing PR). Native message/stop
intents also retain their admitted generation, so a retry cannot act on a replacement.
Stop waits for the CLI to exit and asks the node to dispose; dirty or unpushed work
is retained, reported as `disposed: false`. The public `Workers.stop(ref, reason,
beforeWrite)` supplies the same path to merge execution with a full `WorkerRef`;
a merged ticket remains merged after cleanup.

The daemon binds a mode-0600 socket in a fresh private temporary directory for each instance and issues each
launch an in-memory, per-ticket/generation token. The CLI receives only
`ARMADA_WORKER_SOCKET`, `ARMADA_WORKER_TOKEN` and `ARMADA_TICKET` in its environment.
Only explicitly supplied launch variables are overlaid on a non-secret OS/runtime environment allowlist; daemon keys are not inherited. Its claim/report/heartbeat/ask/release commands use HTTP over that Unix socket,
before V1 config or credentials are discovered. The token fixes project/session
ownership; an invalid, cross-ticket or retired capability refuses without a V1
fallback. Worker release revokes the capability; coordinator stop also waits for
the process to exit. Token values and message bodies never enter launch/delivery
receipts; known capability values are masked in reports and observations.

Production launch/relaunch requires a new successful tracker checkpoint from the host's
bounded refresh before evaluating preflight; a timeout or failure refuses, including
when an older timestamp happens to equal this call's clock. Committed action receipts
replay before refreshing. Embedders supply the same bounded `Workers` refresh hook;
synthetic/offline hosts can intentionally omit it.

Launch intents, progress, and keyed tool receipts live in the shared event log under
the reserved `armada.worker` checkpoint format. `launch-intent` (preparing) and
`launch` (starting/launched) records fold into the same sessions the room rail and
session page read; their reasons name the launch step. A launch reserves its generation
and capacity before preparing. `session.claimed` is appended separately, once the
worker actually claims over its socket. Old claims cannot resurrect a released launch. `session.runtime-observed` records
process state and optional working/idle activity only when either changes. A
one-second daemon poll feeds these observations; fleet reads stay read-only.
After a daemon crash, sessions and intents remain, but processes and capabilities
are not reattached: uncertain launches refuse a duplicate and require inspection.
No unknown-outcome native launch is retried automatically. Shutdown stops only
processes this daemon owns, with a fresh generation check at each native write. Confirmed stops record their runtime state and release only the exact
still-current active generation; failed stops retain active records for inspection.

`test/workers.test.ts` owns real-worktree/process lifecycle and socket admission;
`armada plugin test packages/plugins/node-local` and `.../claude` exercise both
providers against the public fake CLI. The real Claude Code 2.1.310 was also tried through the bound providers during
THE-2015. It launched and stopped cleanly with pipe transport; the final trial
under the filtered environment returned an authentication error. The owner must
sign in through the CLI itself; Armada does not forward daemon credentials to
make that trial pass. CLI error results surface as failed observations.

## Coordinator model plugins

`armadad` resolves the coordinator model from the loaded `model` registry. Both
bundled plugins are enabled by default; neither contacts a service at activation.
`model-anthropic` returns an `@ai-sdk/anthropic` model; `model-openai-compatible`
returns an `@ai-sdk/openai-compatible` chat model. The daemon adapts that SDK
model to pi-ai; durable scheduling and tool execution remain in pi-durable.
SDK failures are replaced by a fixed error before they can enter checkpoints.

For an explicit boot default set `ARMADA_MODEL_KIND=anthropic|openai-compatible`,
`ARMADA_MODEL_NAME`, `ARMADA_MODEL_BASE_URL` (required for compatible endpoints),
and `ARMADA_MODEL_API_KEY`. A complete `ZAI_BASE_URL`, `ZAI_MODEL`, `ZAI_API_KEY`
triple selects the compatible plugin automatically, before a complete
`AZURE_AI_ENDPOINT` (or `AZURE_AI_BASE_URL`), `AZURE_AI_MODEL`, `AZURE_AI_API_KEY` triple. These named
settings can also live under the plugin keychain service. Otherwise the
coordinator keychain entry supplies its kind, public config and key. The app's
key form lists loaded model contributions and saves that entry atomically;
restart to apply it. Disabled providers never appear in that form.

Each project catalog entry may set `coordinatorModel: {kind, config}`. A saved
`rules.set` rule of the same name wins over that entry, then the boot default.
Configuration is public: `model`, `baseURL`, `apiKeySecret`, `apiKeyHeader`
(`authorization` or Azure's `api-key`), and `supportsStructuredOutputs` for
compatible endpoints. Only secret *names* belong in config. The manifest lists
accepted names (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `ARMADA_MODEL_API_KEY`,
`ZAI_API_KEY`, `AZURE_AI_API_KEY`, according to the plugin). `apiKeySecret: null`
explicitly selects a keyless local compatible server. Plugin settings can
provide these same defaults under `config.model.<kind>`; per-project config
wins. A missing key, invalid config or unavailable plugin skips that project's
coordinator with one fixed diagnostic; the fleet/readers remain available.
Model rule changes take effect on daemon restart, like plugin settings.

Run `node --test packages/daemon/test/models.test.ts` from the repository root.
It loads the actual catalog against local endpoint fixtures, checks tools and
structured JSON, and runs a durable coordinator through a tool/result round trip
for each provider. Test credentials are generated in memory and never recorded
in fixtures. For conformance, each model package carries
`armada-plugin.test.json` pointing to the runner's local endpoint.

Model providers may publish a `configSchema` for creation-time settings separately
from their optional activation defaults. The key form uses that schema's required
fields/defaults, and credential writes validate it before saving a key. Legacy
`openai` entries migrate to `openai-compatible` with the OpenAI API endpoint and
`gpt-4.1-mini` unless configured otherwise; older apps retain their `openai` wire
identity while key rotation preserves the saved endpoint/model.

Protocol minor 5 (THE-2043) carries `plans`, `approvalLabel` and `preApprovedLabel`
in folded policy. Older same-major clients keep the earlier policy shape in both
initial and live subscription snapshots, so their strict Rules view stays readable;
the daemon and current clients retain the full policy. The shared per-project fold
is never altered by a legacy client's projection. V1 import rejects approval and
pre-approval labels that normalize alike, including collisions with omitted defaults.

### Coordinator merges (THE-2044)

`merge.check {pr}` reads fresh inspection from the configured forge plugin and
checks the worker's full-SHA hand-back, current phase, GitHub mergeability,
checks, review threads, holds and owner validations. `rules.set` can set
`gates: {requiredChecks: [...], localCommands: [...]}`; the V1 file import carries
`[gates] required_checks/local_commands`. If main is ahead, a declared local
command suite must pass on the exact base/head merge through `node.testMerge`.
GitHub's BEHIND/blocked states still refuse as in V1; the coordinator can have
the worker update its branch.

`merge.run {pr}` runs that checklist, checks the fresh base/head again, and
squash-merges at the exact handed-back head. Merge inspection and each external write have a 30-second cancellation deadline.
The daemon holds one merge lease per project for the full operation; it never expires an in-flight forge write. Local gates have a 15-minute overall deadline; worker cleanup has 30 seconds and keeps its generation fence on late native writes. An unfinished cleanup remains explicit in the journal.
`armada.merge` version-1 checkpoints record intent, confirmation and cleanup.
An interrupted intent is never submitted again: a fresh forge read must prove
that exact head merged. `merge.confirmed` is appended before tracker/worker
cleanup. Retrying `merge.run` resumes failed Done/comment/stop cleanup without
merging again; the stable merged-comment UUID prevents duplicate Linear writes.
The shared worker.stop dispatch handles stop/disposal. A missing stop adapter
leaves an explicit cleanup-pending result. A replacement generation fences old
cleanup. No merge effects run from a reader or a background timer.

The shared worker service now stops and disposes clean workspaces, retaining dirty
or unpushed work. A merge result’s `cleanup.disposed` says whether disposal happened.
