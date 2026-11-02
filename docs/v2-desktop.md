# Armada V2: the desktop app

Decided with the owner on 2026-10-29 after a grilling session. This document is the brief for V2: what it is, what it is not, how it is built, and in what order. It lives beside V1 (the CLI, the hosted dashboard, Linear as the record), which stays until V2 replaces it.

## In one paragraph

Armada V2 is a desktop app for one person who runs a fleet of coding agents on their GitHub repositories. Each repository has one coordinator: a durable agent built on pi that the owner talks to in a chat, and that launches, watches, answers and merges workers. Workers are the vendors' own CLIs (codex, claude, opencode). The coordinator runs on the owner's machine or in a boat.dev VM, per project. The app holds the state, locally, in an append-only event log. There is no Armada server, no web site, no sync, no second user. The app must be able to grow into all four without a rewrite: the value lives in a local daemon and its protocol, not in the shell.

## Decisions

### Product

1. **One user, local first.** No hosted Armada API, no web dashboard, no sync between people. The owner's machine is the authority.
2. **One coordinator per GitHub repository.** A repository is a project. The coordinator is a pi agent (`pi-agent-core`, `pi-ai`, `pi-durable`) running inside the daemon, with the Armada commands (status, inbox, launch, answer, merge, hold, ask the owner) as native tools, not shell calls. Its conversation is durable: the owner can close the app, come back, and continue it.
3. **The coordinator runs where the owner chooses, per project:** on the machine, or in a boat.dev VM. The app stays the authority either way: a VM node registers with the daemon, receives configuration and secrets at launch, and reports back. Leases (launch slots, merge) need no distributed consensus because the coordinator is the single writer for its project.
4. **Workers are the official CLIs**, signed in by the owner in each CLI. Armada never touches a subscription token. The coordinator's own model access comes from pi's provider registry: an API key or pi's provider OAuth sign-in, kept in the OS keychain. Routing rules ("backend on Opus, frontend on Astra, every ticket in a VM") are told to the coordinator in the chat and stored by the app.
5. **Configuration lives in the app**, not in the repository. `armada.toml` is an import for projects that have one. A VM clone knows nothing about Armada until the app hands it what it needs.
6. **Tracker behind an interface.** Linear is the first implementation and the one V2 ships on. A minimal internal tracker follows, behind the same interface: ticket, state, labels, comments, parent and program root, attachments. Nothing else (no cycles, no views, no projects).
7. **GitHub is mandatory**, read and written with the owner's own token (`gh auth` or the device flow). Pull requests, checks and merges carry the owner's name.
8. **The owner decides in the app.** No phone page, no reply-by-chat channel in V1.

### Platform

9. **Three pieces.** `armadad`, a TypeScript daemon that owns the store, the pi coordinator, the runtime adapters and the PTY, behind a typed protocol over WebSocket. A React single-page app that only speaks that protocol, and that the daemon can also serve to a browser. Electron as the first shell: it starts the daemon, owns the window, native dialogs, notifications and auto-update, and nothing else. No Effect; the daemon keeps core's style (pure rules, injected adapters, fakes in tests).
10. **The store is an append-only event log** in SQLite through `node:sqlite` (built into Node, no native addon), folded into derived tables. The fold is pure and tested without I/O. Adding sync later means shipping the log, not migrating a database.
11. **The interface** is Tailwind v4 with the v7 design's tokens in `@theme` (Geist, Geist Mono, the state colours, the "facts line, title, blocks" anatomy), shadcn components on Base UI copied into the code, and Motion for movement. A rule from day one: movement always says something (a state changed, something arrived); no decorative loops in the working view. Rive is reserved for future scenes (ships, a galaxy, a coordinator that reacts), rendered in a canvas layer apart from the list, driven by the same state.
12. **Home screen:** what waits for the owner at the top, the fleet below grouped by state, the coordinator's chat in a panel on the right. Keyboard everywhere, a command palette, live updates by subscription.
13. **In this repository**, as new workspace packages. Core's pure rules (phases, frontier, merge checklist, routing, brief, insights) are copied in as needed; nothing from the dashboard, its API or its store crosses over.

### Refused in V1

Several people on one project, a relay or sync engine, a web site, a phone page, reply by chat channel, SSH machines, the galaxy, Effect. Coordinator subscription OAuth is supported through pi (THE-2073); worker CLI sign-ins stay with their own CLIs.

### Assumptions (not blocking)

Identity is the GitHub account. Secrets are never replicated. The coordinator is the authority for leases. The business model is deferred until multi-user returns. The hosted V1 keeps running for current projects.

## Architecture

```
┌──────────────── Electron shell ────────────────┐
│ window, dialogs, notifications, auto-update     │
│ spawns ──► armadad                              │
└─────────────────────────────────────────────────┘
          ▲ WebSocket, typed protocol (packages/protocol)
┌─────────┴──────────── armadad ─────────────────┐
│ store: event log (SQLite) ─► fold ─► tables      │
│ coordinator: pi agent + Armada tools (per repo)  │
│ tracker: Linear | internal (one interface)       │
│ github: owner's token                            │
│ runtimes: local CLIs, PTY; boat.dev node         │
│ keychain: coordinator API key, project secrets   │
└──────────────────────────────────────────────────┘
          ▲ same protocol
┌─────────┴──────────── SPA (packages/app) ───────┐
│ inbox, fleet by state, coordinator chat, session │
│ page (transcript, diff, terminal), palette       │
└──────────────────────────────────────────────────┘
```

### Packages

- `packages/protocol`: the message types shared by daemon and app (requests, subscriptions, events). Versioned; the app refuses a daemon it does not understand.
- `packages/daemon`: `armadad`. The store, the fold, the coordinator, the tracker interface and its Linear implementation, the GitHub client, the runtime adapters, the boat.dev node, the WebSocket server, the keychain access.
- `packages/app`: the React SPA (Vite, Tailwind v4, shadcn on Base UI, Motion).
- `packages/desktop`: the Electron shell (electron-vite, electron-builder, auto-update).

### The event log

One table of events: `(seq, project, kind, at, actor, payload)`. Every change to the fleet is an event: ticket seen, session claimed, report, heartbeat, question asked, answer given, launch requested, merge queued, merge confirmed, hold opened, hold cleared, validation opened, decision taken, coordinator message, coordinator checkpoint. The fold derives the tables the screens read (sessions, inbox, queue, holds, validations) and is a pure function of the log, tested with synthetic logs. The coordinator's pi-durable checkpoints are events of the same log, so one backup, one export and one future sync cover the conversation too.

Worker inputs have one durable outbox in that same log: `delivery.queued` pins the ticket, session, generation, source, text and delivery key; `delivery.failed` records the attempt, a safe error and the next retry time; `delivery.sent` confirms acceptance. An answer or coordinator message commits its queue intent and receipt atomically and returns the queue id immediately. The `Deliveries` driver resumes unsent inputs after restart, oldest first and in order within each session, retrying the same runtime key after 2 seconds and doubling to a 60-second cap. It checks the current generation before every native write; an ended or changed generation permanently refuses the input instead of sending it to a replacement. Runtime keyed acceptance covers a crash between the write and its sent event. No launch or merge is retried by this outbox.

Three failed attempts derive one stable `delivery-failed` inbox item; later success or the session's end closes it, and the coordinator's usual inbox wake observes it. The room shows “Delivering…” until acceptance and names an answer that could not be delivered. `fleet.status.problems` lists failing deliveries and readers with three consecutive failures; reader streaks live beside the existing `armada.readers` checkpoint and clear on a successful read.


### The coordinator's tools

The coordinator sees the fleet through tools, not through a skill telling it to run a CLI: `fleet.status`, `inbox.list`, `inbox.answer`, `worker.launch`, `worker.relaunch`, `worker.message`, `worker.stop`, `merge.check`, `merge.run`, `hold.add`, `hold.clear`, `owner.ask`, `rules.set`. Each tool is the V1 rule (core's pure derivation or checklist) over the folded tables, with the same refusals. The coordinator's behaviour (when to launch, when to wake the owner, when to merge) is the V1 coordinator skill rewritten as the agent's system prompt, under tests that run the loop against a fake model.

The daemon wakes the coordinator automatically on fleet events: worker hand-backs, questions and plans; owner answers; stopped, silent or unstarted workers; deploy and job notices; in-flight pull request checks turning green or red and confirmed merges; refused merge runs; holds added or cleared by someone else; and default-branch health changes. A fixed ten-second window coalesces changes into one `Fleet wake-up:` input. Durable `coordinator.wakeup` keys and idempotent conversation admission survive restart; running turns receive the input as a steer, and owner messages can still steer that turn. The room shows a quiet `Woke:` row, never an owner bubble; a turn that ends without a message leaves only its Woke row (tool progress streams while it runs). `merge.run` and `worker.launch` stream their stages through tool details. Still-open unanswered items receive reminders only after `policy.coordinatorMinutes` (V1 `coordinator_minutes`, default 10; 0 disables reminders), at most once per `policy.quietMinutes` (default 45). Waiting-for-answer phases do not count as silence. Protocol minor 11 adds wake rows and tool progress; older clients keep their existing chat vocabulary.

The `liveness` wake kind is a progress watchdog for live workers: pure signals count repeated report lines, quiet heartbeats, sustained work without progress, and a stationary shipping head with red checks. Working runtimes receive twice the elapsed-time threshold. Only suspicious sessions supply a masked UTF-8 transcript tail (at most 4 KB) and their last three reports to a single read-only model completion with no tools. The judge defaults to the project's coordinator model; `policy.watchdogModel: { provider, model }` selects another available model in the same registry. It runs at most once per session per `policy.silenceMinutes`, with durable cadence across restart. `looping` and `drifting` verdicts open one notice per progress episode and doubling level, carrying bounded evidence into the room's `Woke:` row. A different report line, phase change or PR head move closes it; repeated identical reports do not. `progressing`, `stuck`, model errors and unavailable transcripts never invent a loop notice. An unsupported transcript seam supplies an empty tail. Errors warn without a notice. The coordinator decides whether to send a fact/decision through `worker.message` or relaunch; the judge cannot mutate or stop a worker. Protocol minor 20 adds these notices and the optional watchdog model policy; earlier clients retain their previous vocabulary.

### Nodes

A node is where sessions run: `local` (the daemon's own machine) or `boat` (a VM created through boat.dev's TypeScript SDK). A node exposes the same small interface: prepare a workspace, start a worker CLI in a PTY, deliver a message, observe, stop. The boat node receives the project's secrets and rules from the daemon at launch over the sandbox's command channel and never stores Armada state. The coordinator itself can run on a boat node: the daemon then relays its tools' calls and keeps the log; the VM holds only the pi process.

## Build order

The first risk to retire is pi-durable on a store of ours through a whole night of coordination. Everything else is plumbing we have written once already.

1. **Daemon skeleton and store** (week 1): `packages/protocol`, `packages/daemon` with the event log, the fold and the WebSocket server; `packages/app` showing the fleet of one existing project read from Linear, by state; `packages/desktop` opening it. The owner sees their fleet in a window.
2. **The coordinator on pi** (weeks 1 to 2, in parallel): pi-agent-core with the Armada tools over the fold, checkpoints in the log, the chat panel in the app; a night on a real project.
3. **Local runtime**: launch a worker CLI in a PTY on the machine, observe, deliver, stop; the session page with transcript and diff; claim, report, ask, release from the worker side through the daemon.
4. **The owner's decisions**: inbox, questions, validations, merge approval, holds; the merge checklist and queue over GitHub with the owner's token.
5. **The boat.dev node**: a VM per ticket or per project, secrets and rules handed at launch, the coordinator optionally running there.
6. **The tracker interface and the internal tracker**: Linear moved behind the interface, the minimal internal tracker, a project that runs with no Linear account.
7. **Finish**: signing, notarisation, auto-update, the command palette, keyboard, native notifications.

## Tickets

Published in Linear under the program root THE-1982 (Spec 1/7 THE-1983, Spec 2/7 THE-1984; steps 1 and 2 are THE-1985 to THE-1998). Specs 3 to 7 are cut after the night run. One ticket per line, grouped by step. Each ticket is one branch, one pull request, and names its owner test. "Pure" means tested without I/O.

### Step 1: daemon, store, first screen

- `protocol`: the message types and versioning; a test that an older app is refused with one line.
- `daemon/store`: the event table in SQLite through `node:sqlite`, append and read since a sequence; the fold into sessions, inbox, queue, holds, validations (pure, synthetic logs).
- `daemon/server`: WebSocket server, subscriptions by project, replay from a sequence on reconnect.
- `daemon/tracker-linear`: read a project's tickets and comments with the owner's Linear key into events (the V1 read adapter, recorded fetch in tests).
- `daemon/github`: read pull requests and checks with the owner's token into events.
- `app/skeleton`: Vite, Tailwind v4 with the v7 tokens, shadcn on Base UI, the shell (sidebar of projects, header facts line).
- `app/fleet`: the fleet grouped by state, each row with its reason in its state's colour, Motion layout animation on a state change.
- `desktop/shell`: Electron starts the daemon, opens the app, quits cleanly.

### Step 2: the coordinator

- `daemon/coordinator-loop`: a pi agent per project with a fake model in tests; its system prompt from the V1 coordinator skill; a checkpoint event per step; resume from the log.
- `daemon/coordinator-tools`: the Armada tools over the fold, each with the V1 refusals; a test per tool.
- `daemon/coordinator-key`: the coordinator's API key in the OS keychain, entered once in the app, never logged.
- `app/chat`: the coordinator's panel, durable, with the tools' calls shown as quiet lines.
- `daemon/rules`: routing and placement rules per project (`rules.set` from the chat, stored, shown in the app).
- A night's run on a real project, logged in this document's follow-up.

### Step 3: local runtime

- `daemon/runtime-local`: start a worker CLI in a PTY in a worktree, observe, deliver, stop; one worker generation per action (V1's guard).
- `daemon/worker-api`: ticket, claim, report, heartbeat, ask, release from the worker through the daemon (the `armada` CLI inside the worktree speaks to the daemon over a local socket with a per-ticket token). `armada ticket [<id>]` reads only that capability's ticket from the event-log fold: metadata, description and comments oldest first; `--json` prints the protocol Ticket. Internal tickets include every logged comment; Linear tickets include the fold's up to twelve comments and link to Linear for older ones. Reads never call a tracker or load credentials; another id is refused with "your capability is for <id>".
- `app/session`: the session page: state card, six steps, transcript, pull request files, "release".
- `app/terminal`: the worker's PTY in the app, read-only by default.

### Step 4: the owner's decisions

- `daemon/inbox`: questions, hand-backs, owner requests as inbox events; answers delivered to the worker.
- `daemon/validations`: open, decide, next waiting one; the `[[policy.validation]]` rule at launch.
- `daemon/merge`: the checklist, the queue, the drain over GitHub with the owner's token; holds.
- `app/inbox`: the home screen's top block; keyboard decisions (A approves, C comments, 1–6 choose).
- `desktop/notifications`: a native notification per owner item, quiet hours.

### Step 5: boat.dev

- `daemon/node-interface`: the node interface and the local implementation moved behind it.
- `daemon/node-boat`: create, reuse and stop a VM through the SDK; hand secrets and rules at launch; run a worker CLI there.
- `daemon/coordinator-remote`: the coordinator running on a boat node, tools relayed, log kept by the daemon.
- `app/placement`: per project, "here" or "boat.dev", and the VMs in flight.

### Step 6: tracker

- `@armada/plugin-api`'s `TrackerProvider`: Linear and internal behind the same `read`/`write` seam, with optional `create` and `update`; the conformance test exercises both and skips methods not implemented by Linear.
- `packages/plugins/internal-tracker` (`internal-tracker`, tracker kind `internal`): tickets, states, labels, comments, parent and blockers in the log through `ticket.created`, `ticket.edited` and `ticket.commented` (protocol minor 22). Its pure fold supplies the same tickets table as Linear. No credentials or separate ticket database; description links carry attachments.
- `app/tickets`: a project's tickets, create and edit, ready to launch.
- `daemon/import-toml`: import an `armada.toml` into the app's rules.

### Step 7: finish

- `desktop/release`: signing, notarisation, auto-update, a release workflow.
- `app/palette`: ⌘K over projects, sessions, tickets and actions.
- `app/motion-rules`: the movement rule written down and checked (no loop in the working view).

## Open decisions, deferred

- Multi-user and sync: an encrypted relay is the likely shape (the log is already the unit of sync); revisit with the business model.
- A phone page for decisions: the daemon can serve the SPA; a tunnel or relay is the missing piece.
- The galaxy: a Rive scene over the same fold, once the working view is proven.


## Plugins

Spec 8/8 (THE-2011) makes everything that varies a provider behind a versioned
service definition. Consumers read the daemon's one registry. Plugins are
in-process ES modules exporting `activate(ctx)`, loaded once at boot. Nothing is
unloaded. A changed switch or configuration takes effect when the daemon
restarts. V2 runs the official worker CLIs itself.

`@armada/plugin-api` (`packages/plugin-api`, API **0.3.0**) owns the manifest
schema and TypeScript contracts, independently of Armada and wire protocol
versions. Its only runtime dependency is Zod, also used by the protocol. The five
seams are `runtime` (prepare, launch a CLI in a PTY, deliver, observe, stop, with
a worker generation on every action), `tracker` (read tickets/comments into
events; write phase labels/comments), `forge` (read PRs/checks into events;
merge at a head), `node` (workspace and PTY facilities, local or VM), and `model`
(create the coordinator's AI SDK model instance). These are definitions only.
Tracker and forge readers use `read({ project, signal })` and append observations
through context events; their consumers own scheduling. The generic model result
lets consumers use their AI SDK version without coupling this API to that SDK.

`TrackerProvider.create({ project, title, description, labels, parent?, blockers?,
state?, url?, source?, actor?, beforeWrite?, signal? })` returns `{ id }`.
`update({ project, ticket, patch, actor?, beforeWrite?, signal? })` edits any ticket
fields other than the identifier. The host also accepts manifests targeting API 0.2.0, since the 0.3 additions
are optional. Existing plugins need no manifest or source changes.
Both methods are optional in API 0.3.0; Linear
leaves them absent. Consumers must refuse unsupported operations explicitly,
and `armada plugin test` reports them as **SKIP: not implemented**. Blockers in
these requests are ticket identifiers; the fold resolves their current statuses.

`PluginEvents` retains `append`, `read` and `fold`. Its one optional capability,
`appendWith(project, (fold) => events[])`, runs a synchronous callback with a
detached current fold under the store's SQLite write lock, then appends the
returned events in one transaction. Every event must belong to that project.
Throwing rolls back the whole append; subscribers see only the committed batch.
Existing plugins and hosts can omit this method. A plugin requiring atomic
allocation refuses mutations explicitly when the host does not provide it.
No async work, nested append or external I/O belongs in the callback.

The bundled **internal-tracker** plugin is enabled by default and contributes
`tracker.internal`, with no configuration or secrets. Its `read` returns at once;
the host reader scheduler still checkpoints success so `readAt.internal`
advances and launch's freshness check passes. `create` allocates `<PREFIX>-<n>`
inside `appendWith`: the first five upper-case letters of the project's id,
with nonletters removed, and one above that prefix's highest existing ticket
number in the project. A project id must contain a letter. Allocation survives
restart and concurrent creates. New tickets default to `backlog`, no parent and
no blockers. `source` and `url` preserve an imported ticket's original identity.

`ticket.created { id, title, description, labels, state, parent, blockers, url?,
source? }`, `ticket.edited { ticket, patch }` and
`ticket.commented { ticket, id, body, author }` are authored facts, folded without
clock or I/O. `state` becomes `Ticket.status`; completed/canceled become
merged/released, otherwise the phase label supplies the phase. Comments keep
the newest twelve (newest first); their ids deduplicate across the full replay,
including comments no longer visible. The envelope's `actor` supplies the
author. Mutation callers pass their actor identity (default: `coordinator`).
An external `ticket.seen` cannot overwrite an internally created ticket.
Ticket edits do not fabricate worker sessions or emit extra phase events.
`write` preserves non-phase labels, applies phase/completed edits and appends
keyed comments, invoking the caller's `beforeWrite` fence before each append.

Every plugin ships with the application under `packages/plugins/<id>/`. The
build runs `scripts/plugin-catalog.ts` to resolve every package's manifest and
module entry into `daemon/src/plugins/catalog.generated.ts`: literal module
imports and embedded manifests, without runtime discovery. Install, typecheck,
daemon tests and CLI builds regenerate the catalog. A new plugin package needs
no loader edit. Its directory name and manifest `id` must agree. `hello` is enabled
by default, contributes nothing, and proves this build-to-activation path.

A manifest is `armada-plugin.json` beside `package.json`, or the package's
`armada` field. If both exist, the standalone file wins. The build resolves the
ES module entry from `exports` (string or `.` with `import`/`default`), then
`main`, then `index.js`. For example:

```json
{
  "id": "linear",
  "version": "1.0.0",
  "pluginApi": "^0.2.0",
  "enabledByDefault": true,
  "description": "Read the project's tickets from Linear",
  "contributions": {
    "tracker": {
      "linear": {
        "config": {
          "type": "object",
          "required": ["team"],
          "properties": { "team": { "type": "string", "minLength": 1 } },
          "additionalProperties": false
        },
        "secrets": ["LINEAR_API_KEY"]
      }
    }
  }
}
```

The app's configuration is `$XDG_CONFIG_HOME/armada/config.json` (otherwise
`~/.config/armada/config.json`); `ARMADA_APP_CONFIG` selects a different file.
It belongs to the app, independently of repository configuration. Its `plugins`
list keeps `{ id, enabled, config }` for catalog entries. An omitted switch uses
the manifest's `enabledByDefault`; a missing file/list uses all catalog defaults.
Disabled plugins are never imported or activated at boot. Configuration selects
only catalog IDs; it cannot select code. For example:

```json
{
  "plugins": [
    { "id": "hello", "enabled": false, "config": {} },
    {
      "id": "linear",
      "enabled": true,
      "config": { "tracker": { "linear": { "team": "ENG" } } }
    }
  ]
}
```

The loader validates enabled manifests, checks their identity and Plugin API
semver range, and validates each contribution's config with JSON Schema draft 7
(Ajv; local references only, synchronous schemas). Missing contribution config is `{}`; explicit
`null` is validated as null. Invalid schemas, unknown contribution config, API
incompatibility and activation errors refuse that plugin with one line and leave
other plugins available. API refusal names the requested range and the daemon's
version. Registrations must match the declared seam/kind, be unique in the
registry, and finish during activation. Every declared contribution must
register. Failed activation publishes no partial providers.

`activate` receives only `ctx.events` (append/read a project's log and fold on
request), `ctx.secrets.get(name)` (through the host's keychain adapter, limited
to names declared in that plugin's contributions), `ctx.config` (validated,
keyed by seam then kind), `ctx.log`, and `ctx.register.<seam>(kind, provider)`.
It receives no database handle, socket or other plugin. Providers may retain
the context; registration ends when activation does. These are trusted
in-process modules. Secret names use the existing owner secret flow.

The shell calls `bootDaemon` with the event database, keychain secret getter and
logger and retains its registry. The `armadad` entry does this before starting
its WebSocket server. Plugin logs go to stderr; stdout first announces
`{"starting":true}`, then progress with the stored event count, then the JSON
readiness line with the bound addresses and boot-stage timings (THE-2117).
Initial readers start after readiness, so that line does not promise reader
health; failures reach stderr and the durable log. The desktop opens a local
startup page immediately and waits without a readiness deadline once the daemon
announces it is starting. Its secret getter uses the shared credential gateway with service
`armada.plugins` and the declared secret name as the account; missing/locked
entries return null. The gateway owns OS storage and the explicit Linux file
fallback. Embedded hosts can supply their own keychain getter. It also atomically saves the boot catalog and
results in the private `<config.json>.plugins.json` status file.
`armada plugin list` prints the catalog, versions, contributions, enabled state
and last boot's loaded/refused state; `--json` returns the same data. Before the
first boot it uses the built-in catalog. Listing never activates a module or
reads secrets. A saved switch that differs from the last boot says restart is
required. Status describes the last boot, independently of process liveness.

`armada plugin enable|disable <id>` changes that switch under a shared process-safe read/modify/write lock, preserves
other app/provider settings, and says to restart the daemon to apply it.
`setPluginEnabled` and `updateAppConfig` are shared with the app's plugin list
(THE-2019, moved into Settings by THE-2069, then under About › Advanced by
THE-2075; Settings › Providers shows the agents as cards, Connections Linear,
GitHub and Armada). It lists the catalog in grouped cards by seam. Each plugin
shows its version, contributions, state on a dot (loaded, off, refused, restart to
apply) and a switch, plus a "Settings" fold: each contribution's
config form, generated from its JSON Schema, and each declared secret as set or
missing, with a password field. It speaks protocol minor 2 (`plugins.list`,
`enable`, `disable`, `configure`, `secret`, `daemon.restart`). The daemon saves
each change at once, checking a config with the loader's own rule, and marks it
"restart to apply" until the next boot. Restart asks the daemon to exit with code
75, and the desktop shell starts it again on the same port, so the app reconnects
on its own. A browser-served daemon without the shell says to quit and reopen.

THE-2013 adds `armada plugin test <dir>`
with seam conformance fixtures. Follow-ups move the Linear/GitHub readers, three
CLI runtimes, local/boat nodes and coordinator models behind the definitions.

The references are [Quivr's manifest](https://github.com/The-Vibe-Company/quivr/blob/main/plugins/rss/quivr-plugin.yaml)
and [versioned SDK](https://github.com/The-Vibe-Company/quivr/blob/main/sdks/go/README.md)
for contributions, schemas and API compatibility, and DeepSeek Harness for the
service definition/provider/consumer vocabulary. Third-party installation,
UI plugins, hot reload, process isolation, layered config, signed plugins and
a plugin marketplace are outside this version. Conductor and herdr are not
V2 runtimes.

## The night run (THE-1998, 2026-10-29 to 2026-10-30)

The first risk is retired. The daemon ran the Armada repository's own fleet on
the owner's Mac through the night that merged Specs 1, 2, 3 and 8: the Electron
window, `armadad` on `node:sqlite`, the pi coordinator on GLM 5.3 Flash through
the openai-compatible model plugin, with pi-durable checkpoints in the log.

- **Durability held.** The daemon was restarted eleven times (merges, plugin
  changes, the `daemon.restart` button). Every restart replayed the log, the
  coordinator's conversation came back whole, and the chat continued where it
  had stopped. No checkpoint was lost or applied twice.
- **The log carried everything.** About 1,300 events by morning, 118 of them
  coordinator checkpoints; the fold rebuilt the room's facts and the hangar's
  counts from the log alone on every boot.
- **Freshness failed, then was fixed.** From THE-2032 (the readers behind the
  plugin loader) to THE-2047, `ctx.secrets.get` read the plugin keychain only,
  so a daemon launched with keys in its environment never read Linear or
  GitHub and the room's facts froze while the UI said "live". THE-2047 reads
  env, then the keychain, then `gh` for GitHub, and stderr names a reader that failed and why. Verified on the owner's machine: ticket and
  pull-request events resume within a minute of a restart.
- **Tokens and night budgets are metered (THE-2109).** Coordinator model completions, watchdog judgments and compaction calls carry input/output/cache usage in their existing durable checkpoint; the replayed fleet sums it per project, civil day and session. The room header and fleet.status show today's reading. Set `policy.budget` through rules.set with a reason: `coordinatorTokensPerDay`, `workerLaunchesPerNight`, optional `nightStart`/`nightEnd` (22:00–07:00), and an IANA `zone`. Reaching a ceiling, or receiving an unknown/partial completed coordinator usage reading under a configured ceiling, opens an ordinary budget hold and one owner-request; launches and merges refuse under it. Only the owner authorizes raising or clearing it with a reason. Clears are exceptions for that ceiling and period; a new day/night or raised ceiling is metered separately. Existing holds remain until cleared. Ordinary merge holds still allow recovery launches; budget holds stop them. Worker release retains the observed token floor and marks the final unverified reading unknown without waiting for the runtime. Tokens include input, output, cache reads and cache writes; no currency estimate is made.
  Worker usage is cumulative per generation: Claude reports the CLI stream's cumulative `modelUsage`, including subagents and compaction (available when a turn finishes); older main-loop-only `usage` is a partial lower bound ([CLI accounting](https://code.claude.com/docs/en/agent-sdk/cost-tracking)); Codex, OpenCode and hosted Conductor currently expose no supported usage counters through their adapters and are explicitly unknown. Missing counters stay unknown, including old logs/snapshots, rather than becoming zero. Worker budgets count launches even when token usage is unknown. Reattachment preserves the observed usage floor and marks an unprovable transcript prefix unknown. Recovery confirms an interrupted launch once; another adoption of the same generation consumes no new launch slot.
- **Still manual.** Launching a worker and merging a pull request from the room
  (THE-2042) exist as tools but have not yet been exercised end to end on a
  real ticket by the owner; that is the first acceptance of the morning.

Specs 4 to 7 (owner decisions, the boat.dev node, the internal tracker, signing
and auto-update) are cut from here.
## Coordinator model connections

Protocol minor 9 lists pi's built-in providers through `models.providers` and
answers `models.catalog`. The catalog contains each provider's public model
metadata, available auth methods, environment variable names, connection status,
and the selected `{ provider, model }` or custom plugin `{ kind, config }`.
OpenAI Codex (ChatGPT) appears first. Keys and OAuth credentials stay in the
daemon keychain under service `armada.pi`, account = provider id. Pi refreshes
OAuth credentials through that same store. Existing custom endpoint plugins and
saved plugin selections continue to work.

The app client exposes `getState().catalog`, `login(provider, authType)`,
`answer(flow, promptId, value)`, `cancel(flow?)`, `logout(provider)`,
`select(provider, model)` and `auth(listener)`. Login's promise resolves on the
final catalog or rejects on a fixed error line; `getState().authFlow` is set
synchronously to its flow id. Auth frames are delivered to `auth(listener)`.
These mutations are never replayed when a connection drops.

The shared transport in `packages/protocol/src/auth.ts` is also the contract for
interactive plugin connections:

- `models.login { id, provider, authType: "oauth" | "api_key" }` starts a flow
  whose id is the request's `id`. All messages include the protocol `version`.
- `auth.event { flow, event }` carries `auth_url`, `device_code`, `progress`,
  `info` (pi's public fields), or `terminal { output }` for terminal providers.
- `auth.prompt { flow, id, promptType, message, placeholder?, options? }` carries
  `text`, `secret`, `select`, or `manual_code`. `promptType` distinguishes the
  prompt kind from the envelope's `type: "auth.prompt"`. Options have
  `{ id, label, description? }`.
- `auth.answer { flow, id, value }` uses the **prompt's id**. It has no success
  reply: the flow continues with its next event/prompt or terminal result.
- `auth.cancel { flow, id }` aborts the flow. Its own request gets a catalog;
  the login request gets an error. The cancel reply waits until that flow is
  terminal and its login slot is free. Disconnect and daemon shutdown abort too.
- A successful login, `models.logout { provider }`, or
  `models.select { provider, model }` returns a catalog. Auth/selection/key
  changes also push a catalog to all minor-9 clients with an independent
  `push:<uuid>` id, so broadcasts cannot complete another client's request.

There is one login at a time, owned by its initiating connection; other clients
cannot answer or cancel its prompts. The daemon never opens a browser. The app
opens an `auth_url` through its desktop bridge or `window.open`; pi's localhost
callback listener runs in the daemon, and a `manual_code` prompt covers a
browser on another machine. Never log answers, copy them into fleet events, or
render a saved credential. `credentials.set` with a pi provider id stores an
API-key credential for that provider without selecting a model. Explicit
`target: "pi" | "plugin"` disambiguates a built-in provider from a plugin with
the same id. Without it, a modern request without `config` targets pi;
requests carrying plugin config and clients before minor 9 retain the plugin
path. Selecting pi preserves the previous plugin credential/config in the
keychain, so project plugin overrides remain usable after restart.

The coordinator's model has two pickers, one component
(`settings/ModelPicker.tsx`'s `ModelPickerContent`, groups and labels from
`settings/models.ts`): Settings › Coordinator's Model row, and the room's
chat bar (THE-2128). In the room the model under the field is a button; a
click or ⌘⇧M opens the picker above it, Escape or a choice closes it and the
focus returns to the field. A provider not connected is listed dimmed with
"Connect in Settings": the chat never starts a sign-in. The picker's head says
what the choice edits. "For every project" is the shared selection,
`models.select { provider, model }`. "For this project" applies when the
project's rules name their own `coordinatorModel`. From minor 24 the room sends
`models.select { provider, model, project }`, and the daemon then writes one
rules checkpoint (`armada.tools`, next revision, actor `owner`, the rest of the
rules kept). A project without an override changes the shared selection. Either
way the daemon reconfigures the coordinator once its harness is idle. A turn in
flight keeps its model and the next turn runs on the new one, with no restart.
Meanwhile the label reads "<model> · next turn". Once the model applies, the
room shows one quiet line, "Coordinator now on <provider>/<model>". The line is
the app's own, kept for the session and never sent to the coordinator. Below
minor 24 a project's own model shows as a plain label.

Provider connection handlers can reuse the daemon's `AuthFlows` adapter in
`src/server/auth.ts`: `start(owner, flowId, send, run, scope?)` runs one
`FlowInteraction` with `signal`, `notify(event)` (including terminal output),
and `prompt(prompt)` returning the answer. `cancel(owner, flowId?)` resolves
to whether it cancelled a flow, once terminal; `cancelScope(scope)` cancels a
matching flow before logout, independent of which client started it; `close()`
aborts and awaits the active flow. Scope strings are opaque (models use
`model:<provider>`). Handlers own their terminal success result; the adapter
emits a fixed error on failure/cancellation. A handler must honor its signal
and settle after cancellation. Neither answers nor terminal secret material
belong in logs or durable events.

Selection requires a known model on a configured provider. The next room turn
resolves the current selection (project/checkpoint rules still win), configures
the durable coordinator and streams directly through pi. A room can be
configured for the first time without restarting the daemon. An active turn
finishes on its model before a newly selected model starts a turn. The daemon
uses the choice saved in Settings first, including custom endpoints. Only when
no choice is saved does it fall back to `ARMADA_MODEL_PROVIDER` and
`ARMADA_MODEL_NAME` (or the legacy `ARMADA_MODEL_KIND` and custom endpoint
settings), then `ZAI_*`, then `AZURE_AI_*`. For a deliberate boot override, set
`ARMADA_MODEL_FORCE=1` with `ARMADA_MODEL_PROVIDER` and `ARMADA_MODEL_NAME`, or
`ARMADA_MODEL_KIND`, `ARMADA_MODEL_NAME` and `ARMADA_MODEL_BASE_URL` for a custom
endpoint. For example, `ARMADA_MODEL_FORCE=1 ARMADA_MODEL_PROVIDER=openai
ARMADA_MODEL_NAME=gpt-4.1-mini` overrides the saved default for that daemon
lifetime. Other flag values do not force a selection, and the flag does not
promote ZAI/Azure fallback settings over a saved choice. The override does not
rewrite the saved choice; removing it restores that choice on the next restart.
Project/checkpoint rules still win over the default. Boot, subsequent turns and
the catalog read the same registry selection, so Settings shows the effective
default, including an explicit override. Provider credentials still honor pi's
environment sources and `ARMADA_MODEL_API_KEY`. Each project's room gets one
quiet `Coordinator uses provider/model.` line when its coordinator opens in a
daemon lifetime, after its actual model is configured and before work resumes.
The pinned pi 1.4.0 package does not
export its `findEnvKeys` helper as a package subpath, so the registry imports
that module beside the daemon dependency; the desktop build bundles it and
pi's statically registered OAuth flows.


### Provider connections (protocol minor 10)

`providers.list` returns `providers.catalog { providers }`, ordered agents, trackers,
forges, models, then nodes. Each entry has `id`, `seam`, `name`, `mark`, optional CLI
`version`, connection `state` (`connected`, `disconnected`, `missing`), optional
`account { label, plan? }` and `detail`, the saved `enabled` switch, safe
`config { binary?, routing? }`, and `restartRequired`. Connection state is independent
of the switch. Bundled providers default to enabled; the sample `hello` does not.
A changed status or saved switch broadcasts the catalog to clients at minor 10 or
newer. Listing and completing a connection refresh status; the daemon also refreshes
every five minutes. No credential or raw CLI auth metadata is part of this catalog.

`providers.connect { id: requestId, provider: providerId }` starts the generic
`auth.event` / `auth.prompt` flow from minor 9; its `flow` is the initiating request
id. A bare `{ type: "providers.connect", id: "codex" }` is also supported. Generic
`auth.answer { flow, id: promptId, value }` and `auth.cancel { id, flow }` work for
both model and provider sign-in. Provider convenience aliases are
`providers.answer { id: promptId, value }` and `providers.cancel { id }`.
Aliases may supply `flow` explicitly; `promptId` can disambiguate the prompt from
an envelope correlation id. Omitted flow binds only to the initiating socket's
current provider sign-in. The client's `answerProvider(promptId, value)` also
accepts the explicit `(flow, promptId, value)` form.
Answers are ephemeral and never echoed. The initiating connection alone may answer
or cancel; dropping it aborts the child process and pending prompt. Completion
returns the refreshed `providers.catalog`; failure returns a sanitized `error`.
`providers.disconnect { id: requestId, provider: providerId }` signs out and refreshes.

Runtime configuration accepts `binary` (an executable path, without shell syntax),
with the former `command` as fallback. Read it from the catalog; edit it with the
existing `plugins.configure` request (`seam: "runtime"`, `kind: providerId`), retaining
other configuration fields. A binary/configuration change applies after restarting
Armada and is marked `restartRequired`. Status probes and connection subprocesses
use the same binary as worker launches. A CLI login streams sanitized terminal
output and URLs; the app owns opening the browser. Linear or GitHub token prompts
write only a declared secret through the daemon's credential store. Disconnect
clears a pasted key; a key supplied by the environment or Armada remains controlled
by that source.
### Runtime projects (THE-2080, protocol minor 12)

`armadad --projects <projects.json>` owns that file as a serialized project registry. A missing file starts with an empty list. Existing entries without a root remain readable; a legacy `checkout` becomes the canonical `root`. New registrations store the real local folder as both `root` and the worker checkout, alongside `id`, `name`, `repository` and `tracker` (`linear` or `internal`, or an explicitly configured plugin kind). Adding with a confirmed program root selects `linear`; leaving it empty selects `internal`, and the project keeps its tickets in Armada. Inspection still suggests the TOML program root, but clearing that suggestion does not restore it. Legacy entries without `tracker` select `linear` when they have a program root and `internal` otherwise. Internal projects read through `tracker.internal`, never poll Linear, and carry no Linear reader telemetry. Project listings expose optional `tracker` metadata from protocol minor 23; an absent field from an older daemon means Linear to the app. Add/remove use a temporary file and atomic rename; no restart is required.

The app client exposes `inspectProject(path)`, `addProject({ path, id, name, repository, programRoot?, phaseGroup? })`, and `removeProject(id)`. Inspection is read-only: Git origin (SSH or HTTPS), branch and cleanliness, TOML program root and labels, suggestions from the folder name, and actionable problems for incomplete folders. The Git remote is the preferred repository suggestion. Adding uses confirmed values and reads the folder's TOML phase, runtime and ready labels. The registry owns provider project maps, so removed/re-added ids cannot inherit stale saved tracker roots. A project without a selected coordinator model retains the daemon's existing unavailable-coordinator behavior; configuring a model is still required for a responding room.

Every wire request keeps its existing correlation `id` and `version`. To avoid overloading that `id`, `projects.add` carries the confirmed project identifier in `projectId`, and `projects.remove` carries it in `project`. Their responses are `projects.result` with the current list; `projects.inspect { path }` responds with `projects.inspection`. New operations require minor 12. Connected clients receive a `projects.result` notification after registration/removal, subscribe only to newly listed projects, and retain prior event logs. A disconnected mutation is never replayed automatically: inspect the list before retrying an unconfirmed add/remove.

Each project's readers and coordinator have independent lifetimes. Removal shares the worker launch queue and refuses active workers or an unresolved launch, including a launch whose workspace is still being prepared. It closes the project's coordinator and readers and retains all events; historical session reads and project subscriptions remain available. Local node configuration uses `node.local.projects[id].root`: worktrees go under `<root>/.armada/worktrees/<ticket>`, with one `/.armada/worktrees/` rule in Git's `info/exclude` (resolved for linked checkouts too). Repository `.gitignore` files are untouched.

If persistence fails, the registry restores its prior services and keeps the committed file/list. If compensation itself fails, it cleans partial recovery, returns an actionable recovery error and pauses all queued/new registry mutations until the daemon restarts. It never announces that failure as a successful add/remove.


Conductor workers (THE-2072, protocol minor 13) run through the optional
`conductor` runtime provider. Enable it in Settings > Providers, configure its
`runtime.conductor` contribution with `binary` (the executable path),
`defaultProfile`, `profiles` (agent, model, effort and optional instructions) and `routing` (labels and
profile, first match). The binary path is an ordinary plugin setting, editable
by Providers. The corresponding `[plugins.conductor]` table in a project's TOML
supplies the same configuration; importing that file's rules selects
`cli = "conductor"` with the profile name as `model`. Install that table's values
as the provider contribution settings too. `armada.v2.toml` declares this
repository's web/opus and api/codex choices. Existing local runtime routing and
socket capabilities remain available.

Sign in to Armada in Settings > Account before launching. The daemon uses that
shared CLI sign-in to mint a one-use, one-hour launch token. Only the brief's
first line contains it: `armada login --launch-token … --api-url …`; the worker
installs Armada, runs that line once, then claims with its Conductor handle.
Creation and later messages use stdin. The daemon stores the launch identity
and runtime handle, never the token or brief. Unknown creation outcomes require
inspection rather than a second create. Signed-out launches refuse before a
workspace is created with “Sign in to Armada in Settings to launch in Conductor”.

While hosted workers are in flight, the daemon polls Armada's inbox and worker
event feed every 15 seconds. Remote claim identities fence each generation;
individual item/event identities deduplicate the local log across restarts.
Questions and hand-backs use the room's existing inbox, and reports use its
existing session events. Answers are delivered through Conductor and recorded
in the hosted inbox. Polls are single-flight and stop during daemon shutdown.
Conductor workspaces are archived after the daemon's explicit stop; in-place
relaunch and Cloud-specific behavior are outside this provider's first version.

The Armada web producer must be deployed before enabling hosted report polling:
`recordReport` fills the existing runtime/handle fields from the claim captured
before asynchronous work. Report path, inbox and session-summary writes recheck that captured claim
inside the existing project transaction. This is additive metadata on the existing event API,
with no schema migration or new route. Legacy report rows without that identity
are not attributed to a current worker; its generation-bound inbox and heartbeat
remain readable. A delayed report from an older claim cannot change its replacement.

GitHub overnight reading (THE-2111): active-ticket pull requests ingest review
and PR discussion comments, unresolved/resolved threads, merge conflicts and
pinned behind-base comparisons. Per-PR `armada.github-reader` v1 checkpoints
retain cursors, conditional reads and independent failure windows. 404 retries;
410 drops immediately; 24 hours of continuous failures abandons and names a PR.
Forge polling follows session activity (30 seconds, otherwise five minutes),
with GitHub cooldowns and doubling backoff retained in its durable checkpoint.
Reader failures are logged on stderr after readiness. External
comments reach the current worker through keyed delivery, suppressing its own
PR-author account; conflict/behind candidates belong to the coordinator Waker.
Protocol minor 18 adds these events and optional PR unresolved/behind facts.

Worker briefs (THE-2096, protocol minor 16) include the ticket, the parent
specification's title and description (up to 4 KiB), repository instructions
(`AGENTS.md`, falling back to `CLAUDE.md`, up to 8 KiB), the project's `[brief] extra`
file, coordinator notes, the complete bundled `armada-worker` protocol, and the
selected routing profile's instructions, in that order. Repository files come
from the registered project root (the configured checkout for older projects).
`brief.extra` must resolve inside that root; a configured missing or unreadable
file refuses launch. Missing repository instructions are optional. Context reads are
bounded before decoding, special files are refused, and `armada.toml` is limited
to 256 KiB.

Every brief is strictly below 48 KiB in UTF-8. The largest optional sections
are shortened with a visible `[truncated: ...]` marker; the ticket and worker
protocol are never cut. Protected content that cannot fit refuses before a token
is minted or a runtime is launched. The protocol travels in the daemon bundle,
so the worker can read it without npm or a network connection. The pinned CLI
installation is only a fallback when `armada` is missing; the worker must report
an installation failure in its first report/reply.

Routes and `defaultRoute` accept optional `instructions` (up to 16,000 characters).
TOML rule import preserves each profile's `instructions` for label, semantic and
default routes, including `[plugins.conductor.profiles.<name>]`. Launch context
uses the selected route without changing selection precedence. Snapshots omit
this field for clients before minor 16; older rule checkpoints remain valid.

Worker restart recovery (THE-2093, protocol minor 15): a normal daemon close,
Settings restart, or plugin restart stops host polling and connections only.
It neither stops worker CLIs nor releases tickets. Local CLIs run under a
detached supervisor that owns their input, output and process group. Its private
endpoint is bound to the complete worker identity; a restarted daemon never
signals a PID copied from disk. Hosted workers are observed through their stored
Conductor workspace/session handle, without another workspace creation.

The existing `armada.worker` launch checkpoint stores runtime/node identity,
workspace provenance, generation and handle, CLI wire mode, hosted launch id and
the local capability's hash. Raw tokens and briefs never enter the event log.
The local worker socket uses the same private path across restarts, guarded by
an owner lease. A live second daemon cannot unlink it. A crashed daemon's lease
may take up to ten seconds to expire before boot can reclaim the endpoint.

Before starting any coordinator, boot observes each in-flight generation and
records `worker.readopted` or `worker.lost`. Recovery leaves ticket phases
unchanged. A lost worker means **relaunch or release, never assume it runs**.
When its runtime can still prove ownership, relaunch stops that exact generation
and retains its local worktree. If ownership is unavailable, restore the runtime
or explicitly release the ticket; Armada refuses to guess a process identity.
Workers launched by older versions without recovery facts are reported lost.

Only an explicit owner WebSocket request ends the project fleet:
`{ type: "fleet.shutdown", version: { major: 1, minor: 15 }, id, project, reason }`.
It is absent from coordinator tools and worker capability commands. Its
`fleet.shutdown.result` reports `ok`, `released` and `failed`; one stop failure
does not prevent attempts for other workers, and an unconfirmed stop retains
its phase. Dirty and unpushed worktrees remain available for recovery.

Local launch reserves its handle and journals the workspace/capability hash
before entering the runtime, so losing the launch reply still leaves a worker
that can be observed and controlled. A recovered CLI with no confirmed initial
brief is identified in the recovery event; the coordinator sends current ticket
instructions before expecting work. The process group's leader stays pinned
until stop escalates across the entire group, including descendants that ignore
SIGTERM. Capability requests accepted during boot wait for recovery; the CLI
retries only a missing/refused connection before any request reached the daemon,
for at most 30 seconds. Authorization failures and reports with an unknown
outcome are never retried; idempotent heartbeats can also reconnect after a
dropped response.

A deliberate Release of an already lost worker can retire the ticket when its
runtime cannot safely stop it. The owner reply carries `stopped: false` and the
release event names the missing stop proof; the native process is never presumed
terminated. Merge cleanup rejects that result and retains its pending cleanup.
Ship the updated CLI with the daemon to give local reports and heartbeats the
bounded connection retry during downtime.


### Linear reader budget (THE-2099, protocol minor 14)

The local Linear reader keeps its completed cursor and prior state in
`armada.linear-reader` event-log checkpoints. Restarting resumes incrementally;
only an absent/expired cursor or the six-hour full-read deadline re-reads the root.
Checkpoints store changes rather than repeating the full program every poll.
Issue/comment deltas share each request, with small paginated nested connections
only on changed issues; external blocker states use a separate lightweight batch.

HTTP 429, Retry-After and GraphQL RATELIMITED pause projects sharing a credential and endpoint,
persist the pause, and prevent manual/coordinator refreshes from bypassing
it. The announced delay is capped at one hour, using reset headers or a one-hour
fallback when absent. The room's header names the pause and its resume time.
Old facts remain readable, and failed or paused reads do not become fresh.

Trackers poll every three minutes when idle and every 30 seconds while a worker is
in flight or the owner is looking at the room. Minor 14 adds optional
`room.presence { project: string | null }`: one visible room per connection, cleared
when hidden, left or disconnected, replayed on reconnect. All-project subscriptions
are not presence. Third-party tracker readers returning void continue to work;
they may optionally return `{ pausedUntil }` to the host scheduler. Forge scheduling
is unchanged. Optional snapshot `readers.linear` carries UTC-hour request count,
last numeric complexity/rate-limit headers and pause-until; older clients ignore it.
About displays the sum of current-hour tracker read requests across projects,
including failed requests and pagination (connection probes and writes are excluded).


### Large-log subscriptions (THE-2116, protocol minor 21)

A fresh `project.subscribe` (`after: 0`), or a cursor more than 2,048 project
events behind, begins with the current folded snapshot on `project.subscribed`
and an empty `events` frame at that snapshot's cursor. Earlier events remain
available through on-demand history/session reads. A recent cursor replays
ordered JSON event pages of at most 1 MiB (UTF-8 bytes), with `more: true` until
the final page. The final authoritative snapshot is sent once; if necessary it
is a separate empty-event frame. Snapshots are indivisible and may exceed the
event-page limit. An event too large for one page falls back to the snapshot.
Older same-major apps receive a snapshot instead of a large partial replay.

Checkpoint events retain only their envelope and `{ checkpoint: null }` on the
fleet stream. The full payload remains in SQLite for folding and conversation
recovery; the cursor notification keeps the room's on-demand `chat.read` fresh.
Conversation content uses the existing chat read/live subscriptions.

Each socket drains to 256 KiB before another replay frame or queued reply is
sent. One blocked subscription coalesces later commits until it drains, then
reads from its pinned cursor. Ten seconds without drain closes with code 4008
and `Replay drain timed out`; the ordinary 8 MiB slow-client guard also closes
with code 4008 and `Client could not drain daemon updates`. The app displays the
close reason, retries up to five unsuccessful connections, then says `Daemon
refused the connection: <reason>`. A project list alone does not reset that
counter; completed initial subscriptions do. A healthy daemon restart resumes
from the last applied cursor.


History is fetched only when its pane opens: Session Reports, the room's agent
lane and Room Log use the one `fleet.history` contract (`project`, optional
`ticket`, exclusive older `cursor`, `limit` default50/max200). SQLite returns
newest-first rows; Load earlier asks for the next page. Each response is also
bounded to1MiB, with an explicit error/retry when a single row is too wide.
The panes retain loaded rows beside newer live events, without subscribing to
history or altering the connection cursor. No table is added. History omits
private checkpoint documents and internal receipts; launch rows are projected
through the public worker launch schema.
