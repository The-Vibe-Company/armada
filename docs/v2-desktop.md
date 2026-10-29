# Armada V2: the desktop app

Decided with the owner on 2026-10-29 after a grilling session. This document is the brief for V2: what it is, what it is not, how it is built, and in what order. It lives beside V1 (the CLI, the hosted dashboard, Linear as the record), which stays until V2 replaces it.

## In one paragraph

Armada V2 is a desktop app for one person who runs a fleet of coding agents on their GitHub repositories. Each repository has one coordinator: a durable agent built on pi that the owner talks to in a chat, and that launches, watches, answers and merges workers. Workers are the vendors' own CLIs (codex, claude, opencode). The coordinator runs on the owner's machine or in a boat.dev VM, per project. The app holds the state, locally, in an append-only event log. There is no Armada server, no web site, no sync, no second user. The app must be able to grow into all four without a rewrite: the value lives in a local daemon and its protocol, not in the shell.

## Decisions

### Product

1. **One user, local first.** No hosted Armada API, no web dashboard, no sync between people. The owner's machine is the authority.
2. **One coordinator per GitHub repository.** A repository is a project. The coordinator is a pi agent (`pi-agent-core`, `pi-ai`, `pi-durable`) running inside the daemon, with the Armada commands (status, inbox, launch, answer, merge, hold, ask the owner) as native tools, not shell calls. Its conversation is durable: the owner can close the app, come back, and continue it.
3. **The coordinator runs where the owner chooses, per project:** on the machine, or in a boat.dev VM. The app stays the authority either way: a VM node registers with the daemon, receives configuration and secrets at launch, and reports back. Leases (launch slots, merge) need no distributed consensus because the coordinator is the single writer for its project.
4. **Workers are the official CLIs**, signed in by the owner in each CLI. Armada never touches a subscription token. The coordinator's own model access is an API key the owner enters once, kept in the OS keychain. Routing rules ("backend on Opus, frontend on Astra, every ticket in a VM") are told to the coordinator in the chat and stored by the app.
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

Several people on one project, a relay or sync engine, a web site, a phone page, reply by chat channel, SSH machines, the galaxy, Effect, subscription OAuth.

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

### The coordinator's tools

The coordinator sees the fleet through tools, not through a skill telling it to run a CLI: `fleet.status`, `inbox.list`, `inbox.answer`, `worker.launch`, `worker.relaunch`, `worker.message`, `worker.stop`, `merge.check`, `merge.run`, `hold.add`, `hold.clear`, `owner.ask`, `rules.set`. Each tool is the V1 rule (core's pure derivation or checklist) over the folded tables, with the same refusals. The coordinator's behaviour (when to launch, when to wake the owner, when to merge) is the V1 coordinator skill rewritten as the agent's system prompt, under tests that run the loop against a fake model.

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
- `daemon/worker-api`: claim, report, heartbeat, ask, release from the worker through the daemon (the `armada` CLI inside the worktree speaks to the daemon over a local socket with a per-ticket token).
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

- `daemon/tracker-interface`: the tracker interface; Linear behind it; a conformance test both implementations pass.
- `daemon/tracker-internal`: tickets, states, labels, comments, parent, attachments in the log; the conformance test.
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

`@armada/plugin-api` (`packages/plugin-api`, API **0.2.0**) owns the manifest
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
its WebSocket server; plugin logs go to stderr so stdout keeps its one JSON
readiness line. Its secret getter uses the shared credential gateway with service
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
`setPluginEnabled` and `updateAppConfig` are shared with the app's Plugins screen
(THE-2019, `#/plugins`, in the sidebar). The screen lists the catalog grouped by
seam. Each plugin shows its version, contributions, state (loaded, off, refused,
restart to apply) and a switch, plus a "Configure" disclosure: each contribution's
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
